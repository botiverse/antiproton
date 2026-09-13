# 本地自托管 Antiproton — 产品计划书 v1.0

> **归档说明（2026-09-10，入库时补写）**
>
> 本文是**设计文档，正文不改**，归档以保留当时的设计论证（与姊妹文档
> [`server-plan-archive.md`](server-plan-archive.md) 的处理一致）。
>
> **现状以 [`README.md`](../README.md) 为准。** 本文写作之后，内核、Harness 与存储层的实现已发生大幅变动
> （例如循环改用 pi 的，删除了自建内核的租约 / fencing / outbox）——其中共享部分的描述同样已过时。

> 与 `server-plan-archive.md`（SaaS / Cloudflare 版，v1.1）并列的第二个部署形态。
> 内核、Harness、Gateway、插件协议完全共用；不同的只是**存储后端、执行后端、归属与迁移机制**。
> 本文只写这一版特有的东西，共用部分标注「见 SaaS 版 §x」。

---

## 0. 一句话

一个**单二进制 + 一个数据目录**就能跑起来的长时 Agent 服务：状态存在本地（每个 Agent 一个 SQLite 文件 + 一个受限工作区目录），JS 在本地 QuickJS 里跑，节点之间靠**增量日志同步**做故障转移；一个 Agent 在被唤醒的整个生命周期里只由一个节点服务，只有它进入 idle **且**同步完成后，下一次请求才允许落到别的节点。

不依赖任何 SaaS：没有 Cloudflare，没有 R2，没有 db9，没有对象存储，没有外部数据库。

---

## 1. 为什么要有这一版

SaaS 版把三件难事外包给了 Cloudflare：

| 难事 | Cloudflare 版怎么解决 | 本地版必须自己解决 |
|---|---|---|
| **单写者**（同一 Agent 不能被两个进程同时推进） | Durable Object 天然单实例，平台保证 | **§8 — 本文最难的一节** |
| 每对象独立存储 | DO 自带 SQLite，`transactionSync` | 每 Agent 一个 SQLite 文件（§5） |
| 休眠与唤醒 | Hibernation + Alarm | 进程内调度器 + 定时器（§7.3） |

换来的是三个真实收益：

1. **数据不出域。** 私有部署、合规场景、内网工具接入，是这个产品能被买单的主要理由。
2. **没有平台限额。** DO 的 CPU-ms、subrequest 数、单对象存储上限全部消失；可以跑几十 MB 的工作区、几分钟的本地计算。
3. **可调试。** 状态是磁盘上一个能用 `sqlite3` 打开的文件，工作区是一个能 `ls` 的目录。这在 SaaS 版里是做不到的。

代价必须说清楚：**失去了平台白送的单写者保证**。整个 §8 都是在还这笔债。

---

## 2. 产品形态

三种打包，同一份二进制：

- **single** — `harness serve --data ./data`。一个进程，一台机器，不迁移。开发、私有部署、绝大多数真实客户的起点。
- **pair** — 两个节点，一主一备，异步同步。主挂了手动/自动接管。有 RPO（§9.5）。
- **cluster** — N 个节点 + 一个仲裁器（§8.3 方案 C）。Agent 按 id 分片到节点，idle 时可再平衡。

**默认是 single。** 这不是妥协，是设计立场：绝大多数长时 Agent 的瓶颈是模型延迟（实测占真实任务墙钟的 ~94%），不是单机吞吐。先把 single 做到无懈可击，再谈迁移。

---

## 3. 从 SaaS 版继承、不允许动的不变量

这几条是上一版用测试换来的，本地版一条都不能松：

1. **Gateway 是唯一出口。** 沙箱、Harness、插件都不能绕过 `ToolGateway` 触达外部世界或文件系统。注意措辞：不是「tool 标签是唯一出口」——那是实现机制，不是安全属性。
2. **配置时绑定。** Agent 只寻址 `alias`，凭据由 `secret_ref` 在服务端解析，永不进入沙箱、checkpoint、trajectory、模型 prompt。
3. **单一结果通道。** `succeeded | pending | running | failed | cancelled | unknown | rejected`；`rejected` 不携带 operationId。
4. **三道闸门。** 每次提交都过 fencing token / generation / checkpoint version，对应 `fenced` / `stale_generation` / `version_conflict`。
5. **命令 id 是派生的，不是随机的。** `sha256(taskId|generation|version|index|kind|payload)`。这一条在本地版里比 SaaS 版**更重要**——它是同步丢尾之后不重复产生副作用的唯一依靠（§9.5）。
6. **隔离是结构性的。** SaaS 版这一条没做到（列级隔离）。本地版**天然做到**：租户是目录，Agent 是文件。见 §11。

---

## 4. 架构总览

```
                    ┌──────────────────────────────────────────────┐
   HTTP / SSE  ───▶ │  Router          按 agentId 粘连，查 residency │
                    ├──────────────────────────────────────────────┤
                    │  Residency       Running/Draining/Idle/Released│
                    │                  租约 + epoch + 自我围栏        │
                    ├──────────────────────────────────────────────┤
                    │  Kernel          三道闸门 / outbox / waits      │
                    │  Harness         codegen | toolcall | hybrid   │
                    ├───────────────┬──────────────────────────────┤
                    │  JsExecutor   │  ToolGateway                  │
                    │  QuickJS 本地  │  ├─ fs      受限工作区          │
                    │               │  ├─ http    出站白名单          │
                    │               │  └─ …       业务插件            │
                    ├───────────────┴──────────────────────────────┤
                    │  LocalStore      每 Agent 一个 SQLite          │
                    │  Workspace       每 Agent 一个受限目录          │
                    ├──────────────────────────────────────────────┤
                    │  Syncer          事件日志推送 + 工作区文件同步    │
                    └──────────────────────────────────────────────┘
                              │ 只在 idle 且同步完成后
                              ▼
                         另一个节点
```

进程内只有一个新增长期组件：**Residency**。其余全部是已有代码换后端。

---

## 5. 状态存储：每 Agent 一个 SQLite

### 5.1 为什么不是「一堆散文件」

「用受限文件系统当状态存储」这个直觉是对的，但**不能直接把内核状态摊成散文件**：

- 内核每一步要**原子地**写 checkpoint + cursor + waits + outbox 四张表。散文件没有事务，崩在中间就是不一致状态，而不一致状态恰恰是三道闸门要防的东西。
- 事件需要**每 (tenant, agent) 单调递增的序号**。文件系统没有单调计数器；用文件名排序会在并发和时钟回拨下失效。
- 增量同步需要**明确的「同步到哪了」**。文件集合的 diff 没有全序；事件日志有。

结论：**内核状态 = 每 Agent 一个 SQLite 文件**（WAL 模式，事务由 SQLite 提供），**Agent 可见的工作区 = 受限目录**。两者要求完全不同，混在一起会两头都做不好。

这个划分还有一个额外好处：**每 Agent 一个文件 = 迁移单元、同步单元、隔离单元三者重合**，和 Durable Object 的对象模型一一对应。SaaS 版做不到的 §12.1 第 1 条（寻址级隔离），本地版是免费的。

### 5.2 目录布局

```
data/
├── index.db                       # 路由索引，见 5.3
├── agents/
│   └── <tenant>/<agent>/
│       ├── state.db               # 内核状态，agent 永远看不到
│       ├── state.db-wal
│       └── workspace/             # agent 通过 fs 插件能看到的全部
│           └── …
└── sync/
    └── <tenant>/<agent>/cursor    # 各 peer 同步到的位置
```

`<tenant>` / `<agent>` 做安全编码：只允许 `[A-Za-z0-9._-]`，其余百分号转义，显式拒绝 `.` 与 `..`，超长的截断加哈希后缀。这一步是**目录穿越的第一道防线**，不能省。

### 5.3 LocalStore：路由，不是重写

`LocalStore implements StorageAdapter` 的实现方式是**路由到 per-agent 的 `SqliteStore` 实例**，而不是重写一遍 700 行逻辑。理由：已经通过 12 条内核契约的那份代码，一行都不该动。

需要一个根索引 `index.db` 解决三个「接口里没带 agentId」的方法：

```sql
CREATE TABLE agent_index (tenant_id, agent_id, created_at, PRIMARY KEY(tenant_id, agent_id));
CREATE TABLE task_index  (tenant_id, task_id,  agent_id,   PRIMARY KEY(tenant_id, task_id));
CREATE TABLE op_index    (tenant_id, operation_id, agent_id, PRIMARY KEY(tenant_id, operation_id));
```

- `loadTask / acquireLease / commitAdvance / releaseIfNoWork / registerWait / interrupt` → 走 `task_index`
- `getOperation / completeOperation` → 走 `op_index`
- `claimOutbox(limit, tenantId?)` → 在 `agent_index` 上扇出。**这是正确的语义**：一个节点只应该 drain 它自己驻留的 Agent。
- `markDispatched(commandId)` → claim 时记忆 `commandId → agent`，缺失时在本租户内回扫

索引未命中即**租户隔离**：`loadTask(其他租户, task)` → `null`，`commitAdvance(其他租户, …)` → `no_task`。这不是检查，是查不到。

**必须补一条 SaaS 版没有的检查**：`appendEvent` 里「事件的 agent 不拥有该 task 就报错」这条断言，在 per-agent 库里会退化成静默通过（那个 task 根本不在这个库里）。所以要在 `LocalStore` 层用全局 `task_index` 先做一次检查，把这条契约提回来。**这是拆库时最容易丢的一条不变量。**

FD 管理：`#lru` 带引用计数的打开表，默认上限 64 个 Agent 库，无引用的按 LRU 关闭。

### 5.4 内核状态 vs 工作区

| | 内核状态 `state.db` | 工作区 `workspace/` |
|---|---|---|
| Agent 能否看见 | **否** | 是（只通过 fs 插件） |
| 一致性要求 | 事务 + 全序 | 最终一致即可 |
| 同步方式 | 事件日志追加推送（§9.1） | 文件级增量（§9.2） |
| 丢尾后果 | 重放（§9.5） | 少几个文件，agent 可重新生成 |

---

## 6. 受限文件系统代理（fs 插件）

这是「用一层代理过的本地文件系统」的落地。它替代 SaaS 版的 R2 artifacts，**接口形状保持一致**，所以 Harness 代码不需要改。

### 6.1 能力面

| 工具 | 参数 | 说明 |
|---|---|---|
| `list` | `path?`, `depth?`, `limit?` | 默认 depth=1，limit=200。上下文经济：不返回整棵树 |
| `read` | `path`, `offset?`, `limit?` | 与 `artifacts.read` 同构：**投影和切片在宿主侧做**，否则卸载到磁盘就没意义了 |
| `write` | `path`, `content`, `mode?` | overwrite / append / create；自动建父目录 |
| `stat` | `path` | 大小、mtime、类型 |
| `delete` | `path` | 单文件；递归删除需显式 `recursive: true` |

**没有 `exec`，没有 `chmod`，没有 `symlink`，没有 `rename` 到区外。** 这个插件不是 bash 的等价物，这是它存在的前提——上一版已经确认「我们不允许给 bash」。

### 6.2 安全模型

每个 Agent 的根是 `data/agents/<tenant>/<agent>/workspace`。路径解析：

1. 拒绝：非字符串、空串、含 `\0`、绝对路径、任意 `..` 或 `.` 段。
2. `path.resolve(base, rel)` 后断言 `abs === base || abs.startsWith(base + sep)`。
3. 从 base 逐段 `lstat`，**任何一段是符号链接就拒绝**（不是 `realpath` 之后比较——那有 TOCTOU 窗口）。
4. 写入前检查配额：单文件 ≤ 1 MiB、总量 ≤ 64 MiB、文件数 ≤ 2000（可配）。

必须有**对抗性测试**，不是「我觉得它安全」。至少覆盖：`../` 穿越、绝对路径、`%2e%2e` 双重编码、指向区外的符号链接（外部预置）、指向区外的硬链接、写入时父目录被换成符号链接（TOCTOU）、超配额、超单文件上限、`\0` 截断、大小写不敏感文件系统上的重名碰撞。

> 上一版我对自己的批评是「57 条测试全是我按自己的设计写的」。这一节是最不能重犯那个错的地方——安全属性必须被攻击过，才算被验证过。

### 6.3 与 artifacts 的关系

`gateway` 把大结果卸载成引用。SaaS 版是 `r2://bucket/t/<tenant>/<agent>/…`，本地版是 `ws://<tenant>/<agent>/…`，前缀校验逻辑一致（在引用本身上强制租户前缀，而不是靠「猜谁写的」）。Harness 侧只认引用，不认后端。

---

## 7. 执行：本地 QuickJS

### 7.1 现状

`src/core/execution.ts` 里的 `JsExecutor` 接缝已经用**替换**证明过了：QuickJS 和 Cloudflare Dynamic Workers 两个实现跑通同一份 9 条执行器契约。本地版只是**不注册第二个实现**，不需要新代码。

### 7.2 限额

Dynamic Worker 那边限额由平台给（`limits.cpuMs`、`subRequests`）。QuickJS 这边必须自己给，且**不能只靠超时**：

- 指令预算（interrupt handler 计数）——防死循环
- 内存上限——防 `new Array(1e9)`
- 墙钟超时——兜底
- 出站：沙箱内**没有** `fetch`、没有 socket、没有 host FS。唯一出口是宿主注入的 tool 桥。这条已有可达性测试（fetch 被拒、socket 被拒、宿主 FS 不可达），不是断言全局变量不存在。

### 7.3 调度与休眠

DO 的 hibernation + alarm 在本地对应：Agent 无事时**不持有任何常驻资源**（`releaseIfNoWork` 成功即释放），只在 `waits` 表里留下 deadline；进程内一个定时器堆按最近 deadline 唤醒。进程重启后从 `waits` 重建定时器堆——这一步必须有测试，否则「重启后定时器全丢」是个静默故障。

### 7.4 Harness 模式

沿用上一版的结论，默认 **hybrid**：`run_js` 是众多工具中的一个，纯查询直接调工具，需要循环/过滤/裁剪时才进 JS。上一版的同模型消融（同模型、同工具、同用户模拟器、同判分，只改一个变量）：

| harness | 完成 | 调用数 | prompt tok | 总 tok | 墙钟 s |
|---|---|---|---|---|---|
| codegen | 5/8 | 17.0 | 76402 | 82088 | 132 |
| toolcall | 7/8 | 9.4 | 40970 | 44282 | 63 |
| hybrid | **8/8** | 9.9 | 52359 | 55716 | **58** |

> 口径声明：8 个任务、单次试验，只说明方向，不构成结论（codegen 在另一组 8 个上是 9/11 的量级）。判分口径也还没对齐官方的 `["DB","NL_ASSERTION"]`。这一条在本地版里同样欠着。

本地版对 hybrid 更友好：QuickJS 在本地没有 CPU-ms 限额，裁剪输出这件事可以做得更狠。

---

## 8. 归属与迁移 —— 本案的核心难点

**这一节是这个方案能不能成立的全部。**

### 8.1 生命周期状态机

```
   ┌──────────┐  收到请求   ┌──────────┐
   │ Released │ ─────────▶ │ Running  │◀─┐ 新消息/操作完成
   └──────────┘            └────┬─────┘  │
        ▲                       │ 无待办   │
        │ 同步完成 & 租约到期      ▼        │
   ┌────┴─────┐  同步完成   ┌──────────┐  │
   │IdleSynced│◀────────── │IdleDirty │──┘
   └──────────┘            └──────────┘
```

- **Running**：持有租约，正在推进。**绝不迁移**，这是用户提的核心约束，也是对的。
- **IdleDirty**：`releaseIfNoWork` 返回 `released`，但本地事件日志还有未推送给 peer 的尾巴。
- **IdleSynced**：所有 peer 的 cursor 都追上了本地最大 sequence。
- **Released**：租约主动释放并广播。此后路由器才允许把该 Agent 的请求发给别的节点。

**只有 `Released` 是可迁移状态。** `IdleSynced` 还不够——租约还在，别的节点接管就是双写。

### 8.2 没有 DO 之后，谁来仲裁单写者

这是唯一真正困难的问题，也是最容易被糊弄过去的问题。

粘连（affinity）是**优化**，不是**正确性**。正确性只能来自租约 + fencing。而租约需要一个**线性一致的仲裁点**。Cloudflare 把这个点白送了；纯本地、shared-nothing、异步同步的架构里，**它不存在**。

必须承认的定理：**shared-nothing 磁盘 + 异步同步，不可能同时拿到「高可用」和「零脑裂」。** 任何声称两者兼得的设计都是把风险藏起来了。

### 8.3 三个可选方案

**A. 单节点，不迁移。**
仲裁器就是操作系统——同一台机器上一个进程持有文件锁（`flock` on `state.db`）。正确性免费，零运维。代价：没有 HA，机器挂了服务就停。
**这是 `single` 形态，也是默认。**

**B. 租约 + 有界时钟漂移 + 自我围栏。**
没有外部组件。节点 A 持有租约到 `T_expire`；节点 B 只有在 `now > T_expire + skew_max` 之后才允许接管。安全性依赖两个前提：
1. 时钟漂移有界（NTP，`skew_max` 取保守值，如 5s）；
2. **A 必须真的停下来**——这是自我围栏（§8.4）。

**这是 `pair` 形态。** 安全等级从「安全」降为「在有界漂移 + 自我围栏纪律下安全」。必须写进文档，不能含糊。

**C. 自托管仲裁器。**
一个小的线性一致存储持有租约表：单点 Postgres、etcd，或节点自组 Raft。安全性最强，代价是**重新引入一个要运维的组件**——但它是自托管的，不违反「不依赖 SaaS」。
**这是 `cluster` 形态，可选插件，不是默认。**

**选型：A 默认，B 是 HA 的开箱选项并明示其条件，C 留接口给真正需要多节点的客户。** 不假装 B 等于 C。

### 8.4 自我围栏协议（方案 B 的核心）

租约不只是「别人不能拿」，更是「**我到点必须停**」。落地成三条硬规则：

1. **每次提交前检查 deadline。** `commitAdvance` 的调用点在写之前断言 `now + margin < leaseExpiry`，否则放弃本次推进（当作 `fenced` 处理）。
2. **每次外部副作用前检查 deadline。** Gateway 在 `invoke` 前做同样断言。租约过期后即使还在内存里跑，也不能再对外部世界做任何事。
3. **epoch 写进同步日志。** 接管方在自己的日志里追加 `ownership.claimed{epoch}`；老节点一旦从 peer 看到更高 epoch，立即自杀式停机该 Agent。这让「接管」在事后可被检测，即使当时没能及时阻止。

GC 停顿、长系统调用会让规则 1/2 的检查迟到——这就是为什么 B 是「有界条件下安全」而不是「安全」。诚实地写下来。

### 8.5 路由器规则

- 请求带 `agentId` → 查 `residency`（本地 index.db + peer gossip）。
- 命中本地且非 Released → 本地处理。
- 命中远端且非 Released → **转发**（不是重定向，客户端不该感知拓扑）。
- 全部 Released → 按策略选节点（就近 / 负载 / 分片哈希），先 `claim` 再服务。
- claim 冲突 → 退让重试，不做「两边都跑，后面再合并」。

### 8.6 失败模式表

| 场景 | 结果 | 依据 |
|---|---|---|
| 节点 A 进程崩溃，Agent 在 Running | B 在租约过期 + skew 后接管，从最后同步点重放 | §8.3B + §9.5 |
| A 网络分区但活着 | A 到点自我围栏，停止提交和副作用；B 接管 | §8.4 规则 1/2 |
| A 长 GC 停顿超过租约 | **窗口内可能双写**；epoch 事后检测 | §8.4 规则 3，已知缺陷 |
| A 时钟被拨快 | A 提前自我围栏 → 可用性损失，不损失安全 | 保守方向 |
| A 时钟被拨慢 | A 延迟自我围栏 → **安全窗口扩大** | 需要 NTP 监控告警 |
| 同步落后，A 挂 | 丢失未同步尾巴 → 重放 | §9.5，RPO = 同步间隔 |

「时钟被拨慢」那一行是方案 B 最真实的风险，必须配 NTP 偏移监控，而不是假设它不会发生。

---

## 9. 增量同步

### 9.1 不同步文件，同步事件日志

内核状态**不要用 rsync 同步 SQLite 文件**：没有原子性，没有全序，WAL 和主文件不一致的瞬间会同步出一个坏库。

正确做法：**内核本来就是事件溯源的**——`events` 表有每 (tenant, agent) 单调的 `sequence`，命令 id 是内容派生的。所以同步就是：

```
push(peer, agent):  ship events where sequence > peer.cursor
                    ship checkpoint blobs where version > peer.ckpt_version
                    ship operations rows where updated_at > peer.watermark
```

接收方按 sequence 顺序重放插入，**天然幂等**（`(tenant, agent, sequence)` 唯一）。这比文件同步简单，而且是有序、增量、可断点续传的。

checkpoint 不完全能从事件推导（Harness 的内部状态是黑盒），所以单独传；但 `checkpoint_version` 单调，传输同样有序幂等。

### 9.2 工作区文件同步

工作区要求松，用文件级增量即可：`(path, size, mtime, blake3)` 清单 diff，只传变化的文件，删除也要传。冲突不可能发生——**同一时刻只有一个节点持有该 Agent 的写权**，这正是 §8 存在的意义。

### 9.3 接管流程

```
1. B 确认 A 的租约已过期 + skew          （不满足 → 拒绝接管，报警）
2. B 从本地副本重建 state.db 与 workspace
3. B 追加 ownership.claimed{epoch = old + 1}
4. B 以新 fencing token 获取租约
5. B 重放未 dispatch 的 outbox           （command_id 派生 → 不重复）
6. B 开始服务
```

### 9.4 什么时候允许迁移

严格按 §8.1：**只有 `Released`。** 具体门槛：

- `releaseIfNoWork` 返回 `released`（内核确认无未消费工作——这条已经防住了 lost wakeup）
- 且 所有 peer cursor ≥ 本地 max sequence
- 且 工作区清单 diff 为空
- 且 租约已主动释放并被 peer 观测到

四条全满足才广播 `Released`。任何一条不满足，请求继续由当前节点服务——**宁可不迁移，不可双写**。

### 9.5 RPO 与「丢尾之后会怎样」

异步同步必然有 RPO = 同步间隔（默认建议 1s，可配到 0 = 同步提交，牺牲延迟）。节点硬挂时，丢失的是最后一小段事件。后果分三种：

1. **内部状态**：从最后同步点重放，无损坏。
2. **已 dispatch 但未同步的外部副作用**：接管方会**重放**这条命令。此时 `command_id` 是内容派生的（§3.5）——插件 `idempotency: "native"` 或 `"key"` 的会被去重，**`"none"` 的会真的做第二次**。
3. **工作区文件**：可能少几个，Agent 可重新生成。

第 2 条是本方案的**真实数据风险**，处理方式不是隐藏它，而是：插件注册时必须声明 idempotency；`none` 的工具在 pair/cluster 形态下默认**要求同步提交**（RPO=0）或被标记为「故障转移后可能重复」。这个选择权交给部署方，但必须显式。

---

## 10. 多租户

本地版在这一点上**优于** SaaS 版当前实现：

| 层 | 隔离手段 |
|---|---|
| 内核状态 | 不同租户是**不同文件**，不是同一张表的不同行 |
| 工作区 | 不同租户是**不同目录**，路径解析强制前缀 |
| 索引 | 主键含 `tenant_id`，未命中即不可见 |
| outbox | `claimOutbox(limit, tenantId)` 按租户扇出，不会跨租户派发 |
| 凭据 | `secret_ref` 按 mount 解析，永不进沙箱 |
| 预算 | **待建**（§14 欠账） |

SaaS 版 §12.1 第 1 条（隔离要是结构，不是一个 join 之外的事）在这里是免费达成的。

---

## 11. 可观测性、保留期、成本

上一版被我自己点名的两个「取消资格级」欠账，本地版必须在 v1 就带上：

- **保留期。** 每 Agent 一个库，所以清理是**每 Agent 独立**的：`events` 保留 N 天或 M 条（取大），已 dispatch 的 outbox 保留 7 天，已完成的 operations 归档到工作区外的冷目录。必须有 `harness gc` 命令 + 自动定时。**没有这个，长跑 Agent 一定撑爆磁盘。**
- **预算与限流。** 每租户/每 Agent 的 token 预算、工具调用速率、JS 指令预算。失控循环必须被拦住。本地版没有云账单来提醒你，所以这条更重要。
- **trajectory 可读。** Agent 应该能读自己的历史（当前两版都做不到）。本地版给了自然实现：trajectory 是工作区里一个只读视图。

---

## 12. 一份代码，四个后端

| 后端 | 存储 | 执行 | 单写者 | 状态 |
|---|---|---|---|---|
| sqlite（进程内） | 内存/单文件 | QuickJS | 进程内 | ✅ 12/12 契约通过 |
| postgres / db9 | TiKV | QuickJS | 数据库 | ✅ 12/12（61s，慢） |
| durable-object | DO SQLite | Dynamic Worker | 平台 | ✅ 12/12 |
| **local（本案）** | per-agent SQLite | QuickJS | **§8** | **待建，必须 12/12** |

准入标准不变：**通不过 `test/spec/kernel-spec.ts` 的后端不是候选**，不管它别的地方多好。

已测的量级参考（同一批 12 个用例）：sqlite 162 ms / db9 61,219 ms / DO 0 ms。本地磁盘不是瓶颈——真实任务里模型占墙钟 ~94%。

---

## 13. 验收矩阵

| # | 场景 | 判据 |
|---|---|---|
| 1 | 12 条内核契约 | LocalStore 全绿 |
| 2 | 9 条执行器契约 | QuickJS 全绿 |
| 3 | fs 越狱 | §6.2 的 10 类攻击**全部被拒**，且有测试 |
| 4 | 进程杀死后恢复 | checkpoint、waits、定时器堆全部重建；outbox 恰好一次派发 |
| 5 | Running 中不迁移 | 强制路由到另一节点 → 被拒绝或转发，绝不双跑 |
| 6 | Released 后迁移 | 新节点接管，对话连续，无重复副作用 |
| 7 | 租约过期自我围栏 | 冻结原节点 > 租约时长，它必须停止提交与外部调用 |
| 8 | 同步丢尾 | 断同步 → 杀主 → 接管；`native/key` 幂等工具不重复，`none` 被正确标记 |
| 9 | 时钟拨慢 | 注入负偏移 → 监控告警触发（不指望它安全） |
| 10 | 配额 | 超工作区配额被拒，Agent 收到可理解的错误而不是崩溃 |
| 11 | 保留期 | 跑满 N 天数据后 gc 生效，磁盘不单调增长 |
| 12 | 预算 | 失控循环被拦截 |

5–9 是这一版**特有**的，也是最该先写的——它们检验的正是 §8 那笔债。

---

## 14. 风险

1. **方案 B 的安全性是有条件的。**（§8.4）最大风险是时钟拨慢和长 GC。缓解：NTP 偏移监控、保守 skew、epoch 事后检测。**不缓解的部分要写在产品文档里，不是藏在代码注释里。**
2. **RPO > 0 时 `idempotency: "none"` 的工具可能重复执行。**（§9.5）缓解：显式声明 + 部署方选择同步提交。
3. **单机没有 HA。** 这是 `single` 形态的定义，不是缺陷；但销售话术不能含糊。
4. **per-agent 文件数。** 十万个 Agent 就是十万个目录。缓解：两级分桶目录、LRU 关闭 FD、冷 Agent 归档成单文件。
5. **测试是我自己写的。** 上一版的自我批评在这里同样成立。§6.2 的越狱测试必须请第三方或对抗性 agent 来打，否则「安全」二字没有证据。

---

## 15. 里程碑

**M1 — 单机可用（本方案的 80% 价值）**
- `src/store/local.ts`（LocalStore 路由 + 根索引 + 拆库后补回 appendEvent 归属检查）
- `src/plugins/fs.ts` + 越狱测试
- `flock` 单写者，`harness serve --data ./data`
- 12 条内核契约 + 9 条执行器契约 + 越狱测试全绿
- 验收 1–4、10

**M2 — 运维闭环（把上一版的欠账还掉）**
- 保留期 / `harness gc`
- 每租户预算与限流
- 重启后定时器堆重建
- trajectory 只读视图
- 验收 11–12

**M3 — 双机热备**
- Residency 状态机 + 自我围栏
- 事件日志同步 + 工作区同步
- 接管流程
- 验收 5–9

**M4 — 可选集群**
- 仲裁器接口 + etcd/Postgres 实现
- 分片与 idle 再平衡

M1 是唯一必须做的；M2 决定它能不能交给别人跑；M3 之后才谈得上 HA。

---

## 附：与 SaaS 版的取舍对照

| | Cloudflare 版 | 本地自托管版 |
|---|---|---|
| 单写者 | 平台保证 | 自己解决（§8），single 免费 / pair 有条件 |
| 冷启动 | 几乎为零 | 进程常驻，零 |
| 计算限额 | CPU-ms、subrequest | 无 |
| 状态规模 | 单对象受限 | 受磁盘限制 |
| 全球就近 | 有 | 无 |
| 运维 | 零 | 有 |
| 数据出域 | 是 | **否** |
| 调试 | 难 | `sqlite3` + `ls` |
| 成本 | 按用量 | 一台机器 |

两版共用内核、Harness、Gateway、插件协议与全部契约测试。**选哪一版是部署决策，不是产品决策。**
