/**
 * Which kernel a bench run's agents run on, and which Durable Object each task runs in.
 *
 * The on-object runners (bench/tau2/cf.ts, bench/swebench/cf.ts) used to run every task of a run in
 * one object, `bench-${OBJ}`, each task clearing the last one's transcript and taking the object over
 * (cf/src/index.ts `benchStart`). That suits pi 0.85, whose transcript is a few tables the object can
 * clear. On pd it cannot work: pi-durable's harness serves one agent per object (`PdHost.bind`,
 * src/runtime/durable-agent.ts) and its tables carry no agent column, so the object refuses a second
 * pd task (cf/src/bench.ts `chooseBenchEngine`). A pd task therefore gets an object of its own,
 * `bench-${OBJ}-${taskId}`, as a production agent does.
 *
 * `OBJECTS=per-task` does the same for pi085, so the two engines can be compared on the same shape;
 * the default for pi085 stays the shared object, so its series continues on the shape it was measured on.
 *
 * With one object per task, the object's activity log covers that task alone: the run's figure is the
 * sum over its tasks' objects (`sumActivity`). Their busy spans cannot overlap within one object, and
 * across objects each is billed on its own, so a sum is what Cloudflare bills.
 */
export type BenchEngine = "pi085" | "pd";
export type ObjectsShape = "shared" | "per-task";

export function benchEngine(v: string | undefined): BenchEngine {
  const e = v === undefined || v === "" ? "pi085" : v;
  if (e !== "pi085" && e !== "pd") throw new Error(`ENGINE must be pi085 or pd, not ${JSON.stringify(v)}`);
  return e;
}

export function objectsShape(engine: BenchEngine, v: string | undefined): ObjectsShape {
  if (engine === "pd") {
    if (v !== undefined && v !== "" && v !== "per-task") throw new Error(`ENGINE=pd runs one task per object; OBJECTS=${v} is not possible`);
    return "per-task";
  }
  const s = v === undefined || v === "" ? "shared" : v;
  if (s !== "shared" && s !== "per-task") throw new Error(`OBJECTS must be shared or per-task, not ${JSON.stringify(v)}`);
  return s;
}

/** The `obj` a task's requests carry: the run's own, or one minted for the task. */
export function taskObject(obj: string, shape: ObjectsShape, taskId: string): string {
  return shape === "per-task" ? `${obj}-${taskId}` : obj;
}

/** `AgentDO.activity`'s answer, as far as a sum needs it. */
export type Activity = {
  activeMs: number; summedMs: number; pollMs: number; invocations: number; spanMs: number;
  byKind: Array<{ kind: string; n: number; ms: number }>;
};

/**
 * Several objects' activity as one. `spanMs` is summed too: each object's span is its task's
 * window, and the tasks of a run follow one another.
 */
export function sumActivity(list: ReadonlyArray<Activity | null | undefined>): Activity & { objects: number } {
  const out = { activeMs: 0, summedMs: 0, pollMs: 0, invocations: 0, spanMs: 0, byKind: [] as Activity["byKind"], objects: 0 };
  const kinds = new Map<string, { n: number; ms: number }>();
  for (const a of list) {
    if (!a) continue;
    out.objects += 1;
    out.activeMs += Number(a.activeMs ?? 0);
    out.summedMs += Number(a.summedMs ?? 0);
    out.pollMs += Number(a.pollMs ?? 0);
    out.invocations += Number(a.invocations ?? 0);
    out.spanMs += Number(a.spanMs ?? 0);
    for (const k of a.byKind ?? []) {
      const e = kinds.get(k.kind) ?? { n: 0, ms: 0 };
      e.n += Number(k.n); e.ms += Number(k.ms);
      kinds.set(k.kind, e);
    }
  }
  out.byKind = [...kinds].map(([kind, v]) => ({ kind, n: v.n, ms: v.ms }));
  return out;
}
