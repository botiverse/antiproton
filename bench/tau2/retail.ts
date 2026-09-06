/**
 * The τ²-bench retail domain as a harness plugin.
 *
 * Semantics follow sierra-research/tau2-bench `retail/tools.py`. Mounting the
 * benchmark rather than special-casing it is the point: if a benchmark can be a
 * plugin, the plugin model is doing its job.
 */
import type { Plugin, ToolSchema } from "../../src/plugins/types.ts";
import type { Json } from "../../src/core/types.ts";

export type RetailDB = { products: any; users: any; orders: any };

const obj = (props: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties: props, required }) as Json;
const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };

const SCHEMAS: Array<ToolSchema & { write: boolean }> = [
  { name: "calculate", summary: "Evaluate an arithmetic expression.", parameters: obj({ expression: str }, ["expression"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "find_user_id_by_email", summary: "Find a user id by email.", parameters: obj({ email: str }, ["email"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "find_user_id_by_name_zip", summary: "Find a user id by first name, last name and zip. Use only when email is unknown.", parameters: obj({ first_name: str, last_name: str, zip: str }, ["first_name", "last_name", "zip"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "get_user_details", summary: "Get a user's details.", parameters: obj({ user_id: str }, ["user_id"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "get_order_details", summary: "Get an order's details.", parameters: obj({ order_id: str }, ["order_id"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "get_product_details", summary: "Get a product and its variants.", parameters: obj({ product_id: str }, ["product_id"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "get_item_details", summary: "Get one item variant by item id.", parameters: obj({ item_id: str }, ["item_id"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "list_all_product_types", summary: "List every product name and id.", parameters: obj({}, []), sideEffects: "read", idempotency: "native", write: false },
  { name: "transfer_to_human_agents", summary: "Hand off to a human agent.", parameters: obj({ summary: str }, ["summary"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "cancel_pending_order", summary: "Cancel a pending order. Reason must be 'no longer needed' or 'ordered by mistake'.", parameters: obj({ order_id: str, reason: str }, ["order_id", "reason"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "modify_pending_order_address", summary: "Change the shipping address of a pending order.", parameters: obj({ order_id: str, address1: str, address2: str, city: str, state: str, country: str, zip: str }, ["order_id", "address1", "address2", "city", "state", "country", "zip"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "modify_pending_order_items", summary: "Swap items in a pending order for other variants of the same product. Can only be called once per order.", parameters: obj({ order_id: str, item_ids: strs, new_item_ids: strs, payment_method_id: str }, ["order_id", "item_ids", "new_item_ids", "payment_method_id"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "modify_pending_order_payment", summary: "Change the payment method of a pending order.", parameters: obj({ order_id: str, payment_method_id: str }, ["order_id", "payment_method_id"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "modify_user_address", summary: "Change a user's default address.", parameters: obj({ user_id: str, address1: str, address2: str, city: str, state: str, country: str, zip: str }, ["user_id", "address1", "address2", "city", "state", "country", "zip"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "return_delivered_order_items", summary: "Request a return for items in a delivered order.", parameters: obj({ order_id: str, item_ids: strs, payment_method_id: str }, ["order_id", "item_ids", "payment_method_id"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "exchange_delivered_order_items", summary: "Request an exchange for items in a delivered order.", parameters: obj({ order_id: str, item_ids: strs, new_item_ids: strs, payment_method_id: str }, ["order_id", "item_ids", "new_item_ids", "payment_method_id"]), sideEffects: "write", idempotency: "none", write: true },
];

export const WRITE_TOOLS = new Set(SCHEMAS.filter((s) => s.write).map((s) => s.name));

export function applyRetailAction(db: RetailDB, name: string, args: any): unknown {
  const getOrder = (id: string) => {
    const o = db.orders[id];
    if (!o) throw new Error("Order not found");
    return o;
  };
  const getUser = (id: string) => {
    const u = db.users[id];
    if (!u) throw new Error("User not found");
    return u;
  };
  const getProduct = (id: string) => {
    const p = db.products[id];
    if (!p) throw new Error("Product not found");
    return p;
  };
  const getVariant = (productId: string, variantId: string) => {
    const v = getProduct(productId).variants[variantId];
    if (!v) throw new Error("Variant not found");
    return v;
  };
  const getPayment = (userId: string, pmId: string) => {
    const pm = getUser(userId).payment_methods?.[pmId];
    if (!pm) throw new Error("Payment method not found");
    return pm;
  };
  const isGift = (pm: any) => pm?.source === "gift_card";
  const r2 = (n: number) => Math.round(n * 100) / 100;

  switch (name) {
    case "calculate": {
      const expr = String(args.expression);
      if (!/^[0-9+\-*/(). ]+$/.test(expr)) throw new Error("Invalid characters in expression");
      // eslint-disable-next-line no-new-func
      return String(r2(Number(new Function(`return (${expr})`)())));
    }
    case "find_user_id_by_email": {
      for (const [uid, u] of Object.entries<any>(db.users)) if (u.email === args.email) return uid;
      throw new Error("User not found");
    }
    case "find_user_id_by_name_zip": {
      for (const [uid, u] of Object.entries<any>(db.users)) {
        if (u.name?.first_name?.toLowerCase() === String(args.first_name).toLowerCase()
          && u.name?.last_name?.toLowerCase() === String(args.last_name).toLowerCase()
          && u.address?.zip === args.zip) return uid;
      }
      throw new Error("User not found");
    }
    case "get_user_details": return getUser(args.user_id);
    case "get_order_details": return getOrder(args.order_id);
    case "get_product_details": return getProduct(args.product_id);
    case "get_item_details": {
      for (const p of Object.values<any>(db.products)) if (p.variants[args.item_id]) return p.variants[args.item_id];
      throw new Error("Item not found");
    }
    case "list_all_product_types": {
      const out: Record<string, string> = {};
      for (const p of Object.values<any>(db.products)) out[p.name] = p.product_id;
      return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
    }
    case "transfer_to_human_agents": return "Transfer successful";

    case "cancel_pending_order": {
      const order = getOrder(args.order_id);
      if (order.status !== "pending") throw new Error("Non-pending order cannot be cancelled");
      if (!["no longer needed", "ordered by mistake"].includes(args.reason)) throw new Error("Invalid reason");
      const refunds = [];
      for (const p of order.payment_history) {
        refunds.push({ transaction_type: "refund", amount: p.amount, payment_method_id: p.payment_method_id });
        const pm = getPayment(order.user_id, p.payment_method_id);
        if (isGift(pm)) pm.balance = r2(pm.balance + p.amount);
      }
      order.status = "cancelled";
      order.cancel_reason = args.reason;
      order.payment_history.push(...refunds);
      return order;
    }
    case "modify_pending_order_address": {
      const order = getOrder(args.order_id);
      if (!String(order.status).includes("pending")) throw new Error("Non-pending order cannot be modified");
      order.address = { address1: args.address1, address2: args.address2, city: args.city, state: args.state, country: args.country, zip: args.zip };
      return order;
    }
    case "modify_user_address": {
      const user = getUser(args.user_id);
      user.address = { address1: args.address1, address2: args.address2, city: args.city, state: args.state, country: args.country, zip: args.zip };
      return user;
    }
    case "modify_pending_order_items": {
      const order = getOrder(args.order_id);
      if (order.status !== "pending") throw new Error("Non-pending order cannot be modified");
      const ids: string[] = args.item_ids, newIds: string[] = args.new_item_ids;
      const all = order.items.map((i: any) => i.item_id);
      for (const id of ids) {
        if (ids.filter((x) => x === id).length > all.filter((x: string) => x === id).length) throw new Error(`${id} not found`);
      }
      if (ids.length !== newIds.length) throw new Error("The number of items to be exchanged should match");
      let diff = 0;
      const variants: any[] = [];
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === newIds[i]) throw new Error("The new item id should be different from the old item id");
        const item = order.items.find((x: any) => x.item_id === ids[i]);
        if (!item) throw new Error(`Item ${ids[i]} not found`);
        const v = getVariant(item.product_id, newIds[i]!);
        if (!v.available) throw new Error(`New item ${newIds[i]} not found or available`);
        variants.push(v);
        diff += v.price - item.price;
      }
      diff = r2(diff);
      const pm = getPayment(order.user_id, args.payment_method_id);
      if (isGift(pm) && pm.balance < diff) throw new Error("Insufficient gift card balance to pay for the new item");
      order.payment_history.push({ transaction_type: diff > 0 ? "payment" : "refund", amount: Math.abs(diff), payment_method_id: args.payment_method_id });
      if (isGift(pm)) pm.balance = r2(pm.balance - diff);
      for (let i = 0; i < ids.length; i++) {
        const item = order.items.find((x: any) => x.item_id === ids[i]);
        item.item_id = newIds[i];
        item.price = variants[i].price;
        item.options = variants[i].options;
      }
      order.status = "pending (item modified)";
      return order;
    }
    case "modify_pending_order_payment": {
      const order = getOrder(args.order_id);
      if (!String(order.status).includes("pending")) throw new Error("Non-pending order cannot be modified");
      const pm = getPayment(order.user_id, args.payment_method_id);
      if (order.payment_history.length !== 1 || order.payment_history[0].transaction_type !== "payment") {
        throw new Error("There should be exactly one payment for a pending order");
      }
      if (order.payment_history[0].payment_method_id === args.payment_method_id) {
        throw new Error("The new payment method should be different from the current one");
      }
      const amount = order.payment_history[0].amount;
      if (isGift(pm) && pm.balance < amount) throw new Error("Insufficient gift card balance to pay for the order");
      const oldId = order.payment_history[0].payment_method_id;
      order.payment_history.push(
        { transaction_type: "payment", amount, payment_method_id: args.payment_method_id },
        { transaction_type: "refund", amount, payment_method_id: oldId },
      );
      if (isGift(pm)) pm.balance = r2(pm.balance - amount);
      const oldPm = getPayment(order.user_id, oldId);
      if (isGift(oldPm)) oldPm.balance = r2(oldPm.balance + amount);
      return order;
    }
    case "return_delivered_order_items": {
      const order = getOrder(args.order_id);
      if (order.status !== "delivered") throw new Error("Non-delivered order cannot be returned");
      const pm = getPayment(order.user_id, args.payment_method_id);
      if (!isGift(pm) && args.payment_method_id !== order.payment_history[0].payment_method_id) {
        throw new Error("Payment method should be the original payment method");
      }
      const all = order.items.map((i: any) => i.item_id);
      const ids: string[] = args.item_ids;
      for (const id of ids) {
        if (ids.filter((x) => x === id).length > all.filter((x: string) => x === id).length) throw new Error("Some item not found");
      }
      order.status = "return requested";
      order.return_items = [...ids].sort();
      order.return_payment_method_id = args.payment_method_id;
      return order;
    }
    case "exchange_delivered_order_items": {
      const order = getOrder(args.order_id);
      if (order.status !== "delivered") throw new Error("Non-delivered order cannot be exchanged");
      const ids: string[] = args.item_ids, newIds: string[] = args.new_item_ids;
      const all = order.items.map((i: any) => i.item_id);
      for (const id of ids) {
        if (ids.filter((x) => x === id).length > all.filter((x: string) => x === id).length) throw new Error(`Number of ${id} not found.`);
      }
      if (ids.length !== newIds.length) throw new Error("The number of items to be exchanged should match.");
      let diff = 0;
      for (let i = 0; i < ids.length; i++) {
        const item = order.items.find((x: any) => x.item_id === ids[i]);
        if (!item) throw new Error(`Item ${ids[i]} not found`);
        const v = getVariant(item.product_id, newIds[i]!);
        if (!v.available) throw new Error(`New item ${newIds[i]} not found or available`);
        diff += v.price - item.price;
      }
      diff = r2(diff);
      const pm = getPayment(order.user_id, args.payment_method_id);
      if (isGift(pm) && pm.balance < diff) throw new Error("Insufficient gift card balance to pay for the price difference");
      order.status = "exchange requested";
      order.exchange_items = [...ids].sort();
      order.exchange_new_items = [...newIds].sort();
      order.exchange_payment_method_id = args.payment_method_id;
      order.exchange_price_difference = diff;
      return order;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function retailPlugin(db: RetailDB, log: Array<{ name: string; args: any }>): Plugin {
  return {
    id: "retail",
    version: "1.0.0",
    tools: SCHEMAS.map(({ write, ...s }) => s),
    async invoke(tool, args) {
      log.push({ name: tool, args });
      return applyRetailAction(db, tool, args) as Json;
    },
  };
}
