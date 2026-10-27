/**
 * An in-memory stand-in for the Prisma client, for the models Loyalty Connect and the webhook route touch (tenant, session, loyalty,
 * loyaltyConnectSettings, loyaltyConnectQueue), with just the query features they use: equality, in, not, lt/lte/gt/gte, orderBy,
 * take, select, include { tenant }, createMany with skipDuplicates on the unique keys, @updatedAt from the test clock.
 */
const DEFAULTS = {
  tenant: () => ({ isActive: true, loyaltyLogin: null, loyaltyToken: null, basicAuthUser: null, basicAuthPass: null, allowedIps: null }),
  session: () => ({ isOnline: false, scope: null, expires: null }),
  loyalty: () => ({}),
  loyaltyConnectSettings: () => ({
    enabled: false, publicKeyEnc: null, secretKeyEnc: null, secretKeyHint: null, storefrontDomain: null, pixelStatus: null, pixelError: null,
    pixelUpdatedAt: null, lastTestAt: null, lastTestOk: null, lastTestMessage: null, lastDeliveryAt: null, lastDeliveryStatus: null,
    lastErrorAt: null, lastError: null,
  }),
  loyaltyConnectQueue: (now) => ({
    status: "PENDING", attempts: 0, nextAttemptAt: now, lockedAt: null, claimToken: null, result: null, lastHttpStatus: null, lastError: null,
  }),
};
const UNIQUE = {
  tenant: [["name"]],
  session: [["id"]],
  loyaltyConnectSettings: [["tenantId"]],
  loyaltyConnectQueue: [["tenantId", "dedupeKey"]],
};

const cmp = (a, b) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);
const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.some((x) => same(x, v))) return false;
      if ("not" in cond && same(cond.not, v)) return false;
      if ("lt" in cond && !(v !== null && v !== undefined && cmp(v, cond.lt) < 0)) return false;
      if ("lte" in cond && !(v !== null && v !== undefined && cmp(v, cond.lte) <= 0)) return false;
      if ("gt" in cond && !(v !== null && v !== undefined && cmp(v, cond.gt) > 0)) return false;
      if ("gte" in cond && !(v !== null && v !== undefined && cmp(v, cond.gte) >= 0)) return false;
      if ("equals" in cond && !same(cond.equals, v)) return false;
      return true;
    }
    return same(cond, v);
  });
}

function sorter(orderBy) {
  const list = !orderBy ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
  return (a, b) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0];
      const d = cmp(a[k], b[k]);
      if (d) return dir === "desc" ? -d : d;
    }
    return 0;
  };
}

class Table {
  constructor(db, name) {
    this.db = db;
    this.name = name;
    this.rows = [];
    this.nextId = 1;
  }

  view(row, args = {}) {
    let out = { ...row };
    if (args.include?.tenant) out.tenant = this.db.tenant.rows.find((t) => t.id === row.tenantId) ?? null;
    if (args.select) out = Object.fromEntries(Object.keys(args.select).filter((k) => args.select[k]).map((k) => [k, out[k]]));
    return structuredClone(out);
  }

  clash(row) {
    return (UNIQUE[this.name] ?? []).some((keys) => this.rows.some((r) => r !== row && keys.every((k) => same(r[k], row[k]))));
  }

  async findMany(args = {}) {
    let rows = this.rows.filter((r) => matches(r, args.where));
    if (args.orderBy) rows = [...rows].sort(sorter(args.orderBy));
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((r) => this.view(r, args));
  }

  async findFirst(args = {}) {
    return (await this.findMany({ ...args, take: 1 }))[0] ?? null;
  }

  async findUnique(args) {
    return this.findFirst(args);
  }

  async create({ data }) {
    const now = this.db.now();
    const row = { ...(DEFAULTS[this.name]?.(now) ?? {}), createdAt: now, updatedAt: now, ...structuredClone(data) };
    if (row.id === undefined) row.id = this.nextId++;
    if (this.clash(row)) throw Object.assign(new Error(`Unique constraint failed on ${this.name}`), { code: "P2002" });
    this.rows.push(row);
    return this.view(row);
  }

  async createMany({ data, skipDuplicates }) {
    let count = 0;
    for (const d of data) {
      try {
        await this.create({ data: d });
        count++;
      } catch (e) {
        if (!(skipDuplicates && e.code === "P2002")) throw e;
      }
    }
    return { count };
  }

  async update({ where, data }) {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw Object.assign(new Error(`Record to update not found in ${this.name}`), { code: "P2025" });
    Object.assign(row, structuredClone(data), { updatedAt: this.db.now() });
    return this.view(row);
  }

  async updateMany({ where, data }) {
    const rows = this.rows.filter((r) => matches(r, where));
    for (const row of rows) Object.assign(row, structuredClone(data), { updatedAt: this.db.now() });
    return { count: rows.length };
  }

  async deleteMany({ where } = {}) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { count: before - this.rows.length };
  }

  async delete({ where }) {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw Object.assign(new Error(`Record to delete not found in ${this.name}`), { code: "P2025" });
    this.rows = this.rows.filter((r) => r !== row);
    return this.view(row);
  }

  async count({ where } = {}) {
    return this.rows.filter((r) => matches(r, where)).length;
  }
}

export function createFakePrisma({ now = () => new Date() } = {}) {
  const db = { now };
  for (const name of ["tenant", "session", "loyalty", "loyaltyConnectSettings", "loyaltyConnectQueue"]) db[name] = new Table(db, name);
  return db;
}
