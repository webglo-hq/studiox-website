/* Developer tool: seed into in-memory PGlite and profile the SQL issued by one orchestration. */
import { createPgliteDriver } from '../../src/framework/store/drivers/pglite';
import { SqlStore, type SqlDriver } from '../../src/framework/store/sql';
import { setStoreClock } from '../../src/framework/store/defaults';
import { ManualClock } from '../../src/framework/util/clock';
import { AgentEngine } from '../../src/packs/accounting/agents/engine';
import { loadScenario } from '../../src/packs/accounting/seed/load';
import { SCENARIO } from '../../src/packs/accounting/seed/scenario';
import { schema, type EkSchema } from '../../src/packs/accounting/store';
import { migrate } from '../../src/server/db';
import { loadSkillsFromDisk } from '../../src/server/skills-fs';

const stats = new Map<string, { n: number; ms: number }>();
let on = false;
function wrap(d: SqlDriver): SqlDriver {
  return {
    kind: d.kind,
    async query(text, values) {
      const t0 = performance.now();
      try {
        return await d.query(text, values);
      } finally {
        if (on) {
          const key = text.replace(/\$\d+/g, '?').replace(/\s+/g, ' ').slice(0, 140);
          const s = stats.get(key) ?? { n: 0, ms: 0 };
          s.n += 1;
          s.ms += performance.now() - t0;
          stats.set(key, s);
        }
      }
    },
    exec: (sql) => d.exec(sql),
    transaction: (fn) => d.transaction((conn) => fn(wrap(conn))),
    close: () => d.close(),
  };
}

const raw = await createPgliteDriver();
await migrate(raw);
const driver = wrap(raw);
const db = new SqlStore<EkSchema>(schema, driver);
const skills = loadSkillsFromDisk();
let t0 = Date.now();
const info = await loadScenario(db, { skills });
console.log('seed ms', Date.now() - t0);
const clock = new ManualClock(SCENARIO.asOf);
setStoreClock(clock);
const engine = new AgentEngine({ db, tenantId: info.tenantId, clock, skills });
on = true;
t0 = Date.now();
const r = await engine.orchestrate(null, info.users.priya);
const total = Date.now() - t0;
console.log('orchestrate ms', total, r.run.summary);
const rows = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms);
console.log('queries', rows.reduce((n, [, s]) => n + s.n, 0), 'sql ms', Math.round(rows.reduce((n, [, s]) => n + s.ms, 0)));
for (const [k, s] of rows.slice(0, 25)) console.log(String(s.n).padStart(6), String(Math.round(s.ms)).padStart(7), 'ms ', k);
await db.close();
