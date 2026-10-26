// Default machines and materials, added once on a fresh database.
// Machine codes are what the code compares; names are what people see.

export const MACHINES = [
  { code: 'press', name: 'التناية', sort: 1 },
  { code: 'shear', name: 'المقص', sort: 2 },
  { code: 'laser', name: 'الليزر', sort: 3 },
  { code: 'punch', name: 'البنش', sort: 4 },
];

const MATERIALS = [
  { name: 'أسود', aliases: ['اسود', 'حديد'], density: 7.85, sort: 1 },
  { name: 'مجلفن', aliases: ['مجلفنة'], density: 7.85, sort: 2 },
  { name: 'ستانلس', aliases: ['استانلس', 'ستانليس'], density: 7.93, sort: 3 },
  { name: 'ألومنيوم', aliases: ['الومنيوم', 'المونيوم', 'AL'], density: 2.7, sort: 4 },
];

export function seedDefaults(db) {
  const seeded = db.prepare("SELECT v FROM meta WHERE k = 'seeded_v1'").get();
  if (seeded) return;
  db.transaction(() => {
    const m = db.prepare('INSERT OR IGNORE INTO machines (code, name, sort) VALUES (?, ?, ?)');
    for (const x of MACHINES) m.run(x.code, x.name, x.sort);
    const mat = db.prepare('INSERT OR IGNORE INTO materials (name, aliases, density, sort) VALUES (?, ?, ?, ?)');
    for (const x of MATERIALS) mat.run(x.name, JSON.stringify(x.aliases), x.density, x.sort);
    db.prepare("INSERT INTO meta (k, v) VALUES ('seeded_v1', datetime('now'))").run();
  })();
}
