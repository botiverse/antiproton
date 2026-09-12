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
/**
 * Parameter descriptions, verbatim from upstream `retail/tools.py`.
 *
 * The first port kept the tool names and semantics and dropped every parameter
 * description. On the object that cost 29 `Order not found` round trips in
 * three runs — every one an order id passed without its leading `#`, which is
 * exactly the thing upstream's description warns about. A benchmark plugin has
 * to carry the benchmark's own hints, or it measures a harder task than the
 * published one.
 */
const d = (description: string, schema: Record<string, unknown> = str) => ({ ...schema, description });
const ORDER_ID = d("The order id, such as '#W0000000'. Be careful there is a '#' symbol at the beginning of the order id.");
const USER_ID = d("The user id, such as 'sara_doe_496'.");
const PRODUCT_ID = d("The product id, such as '6086499569'. Be careful the product id is different from the item id.");
const ITEM_ID = d("The item id, such as '6086499569'. Be careful the item id is different from the product id.");
const PAYMENT_ID = d("The payment method id, such as 'gift_card_0000000' or 'credit_card_0000000'. These can be looked up from the user or order details.");
const ITEM_IDS = d("The item ids to be exchanged, each such as '1008292230'. There could be duplicate items in the list.", strs);
const NEW_ITEM_IDS = d("The item ids to be exchanged for, each such as '1008292230'. There could be duplicate items in the list. Each new item id should match the item id in the same position and be a different variant of the same product.", strs);
const RETURN_ITEM_IDS = d("The item ids to be returned, each such as '1008292230'. There could be duplicate items in the list.", strs);
const MODIFY_ITEM_IDS = d("The item ids to be modified, each such as '1008292230'. There could be duplicate items in the list.", strs);
const ADDRESS = {
  address1: d("The first line of the address, such as '123 Main St'."),
  address2: d("The second line of the address, such as 'Apt 1' or ''."),
  city: d("The city, such as 'San Francisco'."),
  state: d("The state, such as 'CA'."),
  country: d("The country, such as 'USA'."),
  zip: d("The zip code, such as '12345'."),
};

const SCHEMAS: Array<ToolSchema & { write: boolean }> = [
  { name: "calculate", summary: "Calculate the result of a mathematical expression.", parameters: obj({ expression: d("The mathematical expression to calculate, such as '2 + 2'. The expression can contain numbers, operators (+, -, *, /), parentheses, and spaces.") }, ["expression"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "find_user_id_by_email", summary: "Find user id by email. If the user is not found, the function will return an error message.", parameters: obj({ email: d("The email of the user, such as 'something@example.com'.") }, ["email"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "find_user_id_by_name_zip", summary: "Find user id by first name, last name, and zip code. If the user is not found, the function will return an error message. By default, find user id by email, and only call this function if the user is not found by email or cannot remember email.", parameters: obj({ first_name: d("The first name of the customer, such as 'John'."), last_name: d("The last name of the customer, such as 'Doe'."), zip: d("The zip code of the customer, such as '12345'.") }, ["first_name", "last_name", "zip"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "get_user_details", summary: "Get the details of a user, including their orders.", parameters: obj({ user_id: USER_ID }, ["user_id"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "get_order_details", summary: "Get the status and details of an order.", parameters: obj({ order_id: ORDER_ID }, ["order_id"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "get_product_details", summary: "Get the inventory details of a product.", parameters: obj({ product_id: PRODUCT_ID }, ["product_id"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "get_item_details", summary: "Get one item variant by item id.", parameters: obj({ item_id: ITEM_ID }, ["item_id"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "list_all_product_types", summary: "List every product name and id.", parameters: obj({}, []), sideEffects: "read", idempotency: "native", write: false },
  { name: "transfer_to_human_agents", summary: "Hand off to a human agent.", parameters: obj({ summary: str }, ["summary"]), sideEffects: "read", idempotency: "native", write: false },
  { name: "cancel_pending_order", summary: "Cancel a pending order. Reason must be 'no longer needed' or 'ordered by mistake'.", parameters: obj({ order_id: ORDER_ID, reason: d("The reason for cancellation, which should be either 'no longer needed' or 'ordered by mistake'.") }, ["order_id", "reason"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "modify_pending_order_address", summary: "Change the shipping address of a pending order.", parameters: obj({ order_id: ORDER_ID, ...ADDRESS }, ["order_id", "address1", "address2", "city", "state", "country", "zip"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "modify_pending_order_items", summary: "Swap items in a pending order for other variants of the same product. Can only be called once per order.", parameters: obj({ order_id: ORDER_ID, item_ids: MODIFY_ITEM_IDS, new_item_ids: NEW_ITEM_IDS, payment_method_id: PAYMENT_ID }, ["order_id", "item_ids", "new_item_ids", "payment_method_id"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "modify_pending_order_payment", summary: "Change the payment method of a pending order.", parameters: obj({ order_id: ORDER_ID, payment_method_id: PAYMENT_ID }, ["order_id", "payment_method_id"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "modify_user_address", summary: "Change a user's default address.", parameters: obj({ user_id: USER_ID, ...ADDRESS }, ["user_id", "address1", "address2", "city", "state", "country", "zip"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "return_delivered_order_items", summary: "Request a return for items in a delivered order.", parameters: obj({ order_id: ORDER_ID, item_ids: RETURN_ITEM_IDS, payment_method_id: d("The payment method id to receive the refund, which should be the original payment method, or an existing gift card.") }, ["order_id", "item_ids", "payment_method_id"]), sideEffects: "write", idempotency: "none", write: true },
  { name: "exchange_delivered_order_items", summary: "Request an exchange for items in a delivered order.", parameters: obj({ order_id: ORDER_ID, item_ids: ITEM_IDS, new_item_ids: NEW_ITEM_IDS, payment_method_id: d("The payment method id to pay or receive refund for the item price difference, such as 'gift_card_0000000' or 'credit_card_0000000'. These can be looked up from the user or order details.") }, ["order_id", "item_ids", "new_item_ids", "payment_method_id"]), sideEffects: "write", idempotency: "none", write: true },
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
      // Evaluated by a small parser, not by generating code: Workers refuse
      // `new Function` ("Code generation from strings disallowed"), which made
      // this tool fail on the object eight times in three runs while passing
      // every in-process test. Upstream uses Python's eval with the same
      // character set; the grammar is numbers, + - * /, parentheses.
      return String(r2(arithmetic(String(args.expression))));
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
    // Everyone gets it, because a bench task is the reason this plugin exists:
    // the object arm mounts it in `benchStart`, and the alternative to saying so
    // is a run whose agent never sees the domain it is being asked about.
    defaultForAllAgents: true,
    tools: SCHEMAS.map(({ write, ...s }) => s),
    async invoke(tool, args) {
      log.push({ name: tool, args });
      return applyRetailAction(db, tool, args) as Json;
    },
  };
}


/** Numbers, + - * /, unary minus, parentheses. Throws on anything else. */
export function arithmetic(expr: string): number {
  const src = expr.replace(/\s+/g, "");
  if (!/^[0-9+\-*/().]+$/.test(src)) throw new Error("Invalid characters in expression");
  let i = 0;
  const peek = () => src[i];
  const next = () => src[i++];
  function number(): number {
    const start = i;
    while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
    if (start === i) throw new Error(`Expected a number at position ${start}`);
    const n = Number(src.slice(start, i));
    if (!Number.isFinite(n)) throw new Error(`Bad number: ${src.slice(start, i)}`);
    return n;
  }
  function factor(): number {
    if (peek() === "-") { next(); return -factor(); }
    if (peek() === "+") { next(); return factor(); }
    if (peek() === "(") {
      next();
      const v = expression();
      if (next() !== ")") throw new Error("Expected ')'");
      return v;
    }
    return number();
  }
  function term(): number {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const r = factor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function expression(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = expression();
  if (i !== src.length) throw new Error(`Unexpected '${src[i]}' at position ${i}`);
  return v;
}
