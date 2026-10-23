// Mock data generator (plan section 28). Deterministic: same data every run unless SEED_RANDOM=1.
// Stage A scope: catalogs, bases, sites, units, seats, employees, certifications, demo users.
// Jobs / assignments / leave history and the 14 planted scenarios are added with E9-E16.
import '../src/env';
import { PrismaClient, Prisma } from '@prisma/client';
import { faker } from '@faker-js/faker/locale/fr';
import { hashPassword } from '../src/auth/crypto';
import { singleConnectionUrl, wipeDatabase } from '../src/prisma/migrate';

const prisma = new PrismaClient({ datasourceUrl: singleConnectionUrl() });
faker.seed(process.env.SEED_RANDOM ? Date.now() : 42);

const NOW = new Date('2026-10-19T00:00:00Z');
// SEED_SCALE=5 builds five times the units and people (same four bases) for the performance test (plan E28).
const SCALE = Math.max(1, parseInt(process.env.SEED_SCALE ?? '1', 10) || 1);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const daysAhead = (n: number) => daysAgo(-n);

const BASES = [
  { code: 'HMD', name: 'HMD Base', city: 'Hassi Messaoud', lat: 31.6728, lng: 6.0735, region: 'North-East' },
  { code: 'INA', name: 'In Amenas', city: 'In Amenas', lat: 28.0501, lng: 9.5643, region: 'South-East' },
  { code: 'TMN', name: 'Timimoun', city: 'Timimoun', lat: 29.2639, lng: 0.2309, region: 'South-West' },
  { code: 'HRM', name: "Hassi R'Mel", city: "Hassi R'Mel", lat: 32.9333, lng: 3.2667, region: 'North-East' },
];

const SURNAMES = ['Benali', 'Boudiaf', 'Cherif', 'Djebbar', 'Haddad', 'Kaci', 'Lounis', 'Messaoudi', 'Nouri', 'Ouali', 'Rahmani', 'Saadi', 'Taleb', 'Yahiaoui', 'Zerrouki', 'Belkacem', 'Hamidi', 'Mansouri'];
const FIRSTNAMES = ['Karim', 'Yacine', 'Samir', 'Amine', 'Nabil', 'Redouane', 'Walid', 'Sofiane', 'Hicham', 'Mourad', 'Farid', 'Lyes', 'Bilal', 'Anis', 'Riad', 'Salim', 'Tarek', 'Ilyes'];

async function main() {
  await wipeDatabase(prisma);

  // ---- Catalogs
  const [qOH, qCH, qMech, qElec, qWeld] = await Promise.all(
    ['Open Hole', 'Cased Hole', 'Heavy vehicle mechanics', 'Electronics/tool repair', 'Welding'].map(name =>
      prisma.qualification.create({ data: { name } })),
  );
  const [h2s, firstAid, driving] = await Promise.all(
    ['H2S', 'First aid', 'Heavy driving licence'].map(name => prisma.certificationType.create({ data: { name } })),
  );
  const [r2828, r1414, r52, r217] = await Promise.all([
    prisma.rotationPattern.create({ data: { name: '28/28', type: 'cycle', daysOn: 28, daysOff: 28 } }),
    prisma.rotationPattern.create({ data: { name: '14/14', type: 'cycle', daysOn: 14, daysOff: 14 } }),
    prisma.rotationPattern.create({ data: { name: '5/2 weekly', type: 'weekly', weeklyMask: '1111100' } }),
    prisma.rotationPattern.create({ data: { name: '21/7', type: 'cycle', daysOn: 21, daysOff: 7 } }),
  ]);

  type P = [string, 'FIELD_CREW' | 'BASE_STAFF' | 'MANAGEMENT', boolean, boolean, string, string[], string[]];
  const posDefs: P[] = [
    ['Field Operator', 'FIELD_CREW', true, false, r2828.id, [], [h2s.id, firstAid.id]],
    ['Chief of Unit', 'FIELD_CREW', true, false, r2828.id, [], [h2s.id, firstAid.id]],
    ['Field Engineer', 'FIELD_CREW', true, false, r2828.id, [], [h2s.id]],
    ['Field Driver', 'FIELD_CREW', true, false, r2828.id, [], [h2s.id, driving.id]],
    ['Mechanic', 'BASE_STAFF', false, true, r217.id, [qMech.id], []],
    ['Electronics Technician', 'BASE_STAFF', false, true, r52.id, [qElec.id], []],
    ['Welder', 'BASE_STAFF', false, true, r52.id, [qWeld.id], []],
    ['Shop Foreman', 'BASE_STAFF', false, true, r52.id, [], []],
    ['Storekeeper', 'BASE_STAFF', false, true, r52.id, [], []],
    ['Base Driver', 'BASE_STAFF', false, true, r52.id, [], [driving.id]],
    ['HSE Officer', 'BASE_STAFF', false, true, r52.id, [], [firstAid.id]],
    ['Base Manager', 'MANAGEMENT', false, true, r52.id, [], []],
    ['Dispatcher', 'MANAGEMENT', false, false, r52.id, [], []],
    ['Admin Officer', 'MANAGEMENT', false, false, r52.id, [], []],
  ];
  const pos: Record<string, { id: string }> = {};
  for (const [name, category, unit, base, rot, quals, certs] of posDefs) {
    pos[name] = await prisma.position.create({
      data: {
        name, category, canFillUnitSeat: unit, canFillBasePost: base, defaultRotationId: rot,
        requiredQualifications: { connect: quals.map(id => ({ id })) },
        requiredCertTypes: { connect: certs.map(id => ({ id })) },
      },
    });
  }

  for (const [name, category, needsDocument] of [
    ['Annual leave', 'leave', false], ['Medical leave', 'medical', true], ['Recovery days', 'leave', false],
    ['Training', 'training', false], ['Exceptional leave', 'leave', false],
    ['Maternity/Paternity', 'leave', true], ['Unpaid leave', 'leave', false], ['Unjustified absence', 'absence', false],
  ] as const) {
    await prisma.leaveType.create({ data: { name, category, needsDocument, needsApproval: name !== 'Medical leave' && name !== 'Unjustified absence' } });
  }

  const oh = await prisma.unitType.create({ data: { name: 'Open Hole', colorKey: 'green' } });
  const ch = await prisma.unitType.create({ data: { name: 'Cased Hole', colorKey: 'amber' } });
  for (const [ut, q] of [[oh, qOH], [ch, qCH]] as const) {
    await prisma.crewTemplateSeat.createMany({
      data: [
        { unitTypeId: ut.id, positionId: pos['Chief of Unit'].id, count: 1, requiredQualId: q.id },
        { unitTypeId: ut.id, positionId: pos['Field Operator'].id, count: 3, requiredQualId: q.id },
      ],
    });
  }

  // ---- Bases, sites, staffing templates
  const regions: Record<string, { id: string }> = {};
  const bases: Record<string, { id: string }> = {};
  for (const b of BASES) {
    regions[b.region] ??= await prisma.region.create({ data: { name: b.region } });
    bases[b.code] = await prisma.base.create({
      data: {
        code: b.code, name: b.name, city: b.city, lat: b.lat, lng: b.lng, regionId: regions[b.region].id,
        unitCapacity: 6, bedCapacity: 30, facilities: ['mechanical workshop', 'wash bay'],
      },
    });
    for (let i = 1; i <= 7; i++) {
      await prisma.site.create({
        data: {
          name: `${b.code}-W${i}`, baseId: bases[b.code].id, client: faker.helpers.arrayElement(['Sonatrach', 'Anadarko', 'Repsol']),
          lat: b.lat + faker.number.float({ min: -1, max: 1 }), lng: b.lng + faker.number.float({ min: -1, max: 1 }),
          travelHours: faker.number.int({ min: 1, max: 6 }),
        },
      });
    }
  }

  // ---- Units (9 OH, 7 CH) + crew seats
  const units: { id: string; code: string; type: 'OH' | 'CH'; base: string }[] = [];
  const baseCodes = BASES.map(b => b.code);
  for (let i = 0; i < 16 * SCALE; i++) {
    const type = i % 16 < 9 ? 'OH' : 'CH';
    const base = baseCodes[i % baseCodes.length];
    const code = `HL-${6700 + i * 7}`;
    const u = await prisma.unit.create({
      data: {
        code, unitTypeId: (type === 'OH' ? oh : ch).id, homeBaseId: bases[base].id,
        status: i % 16 === 15 ? 'OUT_OF_SERVICE' : 'AVAILABLE', plate: `${faker.number.int({ min: 10000, max: 99999 })} 1${i} 16`, year: 2012 + (i % 10),
      },
    });
    units.push({ id: u.id, code, type, base });
    const q = type === 'OH' ? qOH : qCH;
    const seats: Prisma.SeatCreateManyInput[] = [
      { holderType: 'UNIT', unitId: u.id, positionId: pos['Chief of Unit'].id, index: 1, requirements: { qualification: q.name } },
      ...[1, 2, 3].map(index => ({ holderType: 'UNIT' as const, unitId: u.id, positionId: pos['Field Operator'].id, index, requirements: { qualification: q.name, ...(index === 1 ? { minSeniority: 'EXPERIENCED' } : {}) } })),
    ];
    await prisma.seat.createMany({ data: seats });
  }

  // ---- Employees (~140). Seniority mix: 15% new, 30% junior, 40% experienced, 15% senior.
  let no = 1000;
  const hireFor = () => {
    const r = faker.number.float({ min: 0, max: 1 });
    const yearsAgo = r < 0.15 ? 0.3 : r < 0.45 ? 1.2 : r < 0.85 ? 3.5 : 7;
    return daysAgo(Math.round(yearsAgo * 365 + faker.number.int({ min: 0, max: 120 })));
  };
  const mix: [string, number][] = [
    ['Field Operator', 108], ['Chief of Unit', 24],
    ['Base Manager', 4], ['Dispatcher', 2], ['Admin Officer', 2],
  ];
  const created: { id: string; position: string }[] = [];
  const cycleLength = (rotationId: string) => ({ [r2828.id]: 56, [r1414.id]: 28, [r217.id]: 28, [r52.id]: 7 }[rotationId] ?? 56);
  for (const [position, perScale] of mix) {
    const count = perScale * SCALE;
    const def = posDefs.find(p => p[0] === position)!;
    for (let i = 0; i < count; i++) {
      const base = baseCodes[i % baseCodes.length];
      const first = faker.helpers.arrayElement(FIRSTNAMES), last = faker.helpers.arrayElement(SURNAMES);
      const quals: string[] = [...def[5]];
      if (def[2]) { // unit-seat positions are OH, CH or both
        const r = faker.number.float({ min: 0, max: 1 });
        if (r < 0.45) quals.push(qOH.id); else if (r < 0.9) quals.push(qCH.id); else quals.push(qOH.id, qCH.id);
      }
      const hire = hireFor();
      const e = await prisma.employee.create({
        data: {
          employeeNo: `E${no++}`, firstName: first, lastName: last,
          phone: `0555${faker.string.numeric(6)}`, email: `${first}.${last}${no}@crewboard.test`.toLowerCase(),
          positionId: pos[position].id, hireDate: hire,
          workMode: def[2] ? 'FIELD' : def[3] ? 'BASE' : 'FLEXIBLE',
          // Field-crew history from before the system: roughly half of the time since hire (28/28 rotations).
          priorFieldDays: def[2] ? Math.round(((NOW.getTime() - hire.getTime()) / 86_400_000) * faker.number.float({ min: 0.35, max: 0.5 })) : 0,
          homeBaseId: bases[base].id, homeCity: BASES.find(b => b.code === base)!.city,
          rotationPatternId: def[4], // Spread the rotation starts evenly inside each base, so about half of every group is on at any time (no random clumps).
          rotationAnchorDate: daysAgo(Math.floor((Math.floor(i / baseCodes.length) / Math.ceil(count / baseCodes.length)) * cycleLength(def[4]))),
          qualifications: { create: quals.map(qualificationId => ({ qualificationId, obtainedAt: hire })) },
        },
      });
      created.push({ id: e.id, position });
      // Certifications are held or not; they never expire. The random draws are kept so the rest of the seed
      // (names, mixes) stays the same as before expiry was removed.
      for (const typeId of def[6]) {
        const r = faker.number.float({ min: 0, max: 1 });
        void (r < 0.02 ? daysAgo(faker.number.int({ min: 1, max: 30 })) : r < 0.10 ? daysAhead(faker.number.int({ min: 5, max: 60 })) : daysAhead(faker.number.int({ min: 120, max: 700 })));
        await prisma.certification.create({ data: { employeeId: e.id, typeId, issuedAt: daysAgo(400) } });
      }
    }
  }

  // ---- Demo users. Every demo account uses the password "demo1234" (demo mode only).
  const roles: [string, string][] = [
    ['admin', 'SUPER_ADMIN'], ['ops', 'OPS_MANAGER'], ['dispatcher', 'DISPATCHER'], ['hr', 'HR'],
    ['basemanager', 'BASE_MANAGER'], ['chief', 'CHIEF_OF_UNIT'], ['employee', 'EMPLOYEE'],
  ];
  const demoHash = hashPassword('demo1234');
  const everyone = await prisma.employee.findMany({ select: { id: true, employeeNo: true, position: { select: { name: true } }, homeBase: { select: { code: true } } }, orderBy: { employeeNo: 'asc' } });
  const firstOperator = everyone.find(e => e.position.name === 'Field Operator');
  // SEED_STAFF=off creates only the manager (admin) and the employee logins: the setup the product runs with now.
  // The staff accounts are on by default because the smoke suites sign in with them.
  const staffOff = process.env.SEED_STAFF === 'off';
  for (const [login, role] of roles) {
    if (staffOff && role !== 'SUPER_ADMIN' && role !== 'EMPLOYEE') continue;
    await prisma.user.create({
      data: {
        login, passwordHash: demoHash, employeeId: login === 'employee' ? firstOperator?.id : undefined,
        // Staff accounts have no employee record, so they get their own address (for password reset emails).
        email: login === 'employee' ? undefined : `${login}@crewboard.local`,
        roles: { create: { role, baseScope: role === 'BASE_MANAGER' ? 'HMD' : undefined } },
      },
    });
  }
  // Each person can sign in to the portal with their employee number, e.g. "e1010".
  for (const e of everyone) {
    if (e.id === firstOperator?.id) continue; // already linked to the generic "employee" account
    const extra: { role: string; baseScope?: string }[] = [{ role: 'EMPLOYEE' }];
    if (e.position.name === 'Chief of Unit') extra.push({ role: 'CHIEF_OF_UNIT' });
    if (e.position.name === 'Base Manager') extra.push({ role: 'BASE_MANAGER', baseScope: e.homeBase.code });
    await prisma.user.create({ data: { login: e.employeeNo.toLowerCase(), passwordHash: demoHash, employeeId: e.id, roles: { create: extra } } });
  }

  // ---- Preventive maintenance and unit papers. Spread by unit index (no random draws, so the people stay the same)
  // and relative to today, so some services are always overdue or due soon and an insurance or two is expiring.
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const ago = (n: number) => new Date(today.getTime() - n * 86_400_000);
  const fleet = await prisma.unit.findMany({ orderBy: { code: 'asc' } });
  for (const [i, u] of fleet.entries()) {
    await prisma.maintenancePlan.createMany({ data: [
      { unitId: u.id, name: 'Engine service', everyDays: 90, durationDays: 2, leadDays: 14, startFrom: ago(400), lastDone: ago((i * 13) % 100) },
      { unitId: u.id, name: 'Logging cable and winch check', everyDays: 180, durationDays: 1, leadDays: 14, startFrom: ago(400), lastDone: ago((i * 23) % 175) },
      { unitId: u.id, name: 'Annual technical inspection', everyDays: 365, durationDays: 3, leadDays: 30, startFrom: ago(400), lastDone: ago((i * 29) % 360) },
    ] });
    await prisma.unitDocument.createMany({ data: [
      { unitId: u.id, kind: 'registration', title: `Registration ${u.plate ?? u.code}` },
      { unitId: u.id, kind: 'insurance', title: 'Fleet insurance', expiresAt: new Date(today.getTime() + (((i * 37) % 400) - 20) * 86_400_000) },
    ] });
  }

  const counts = {
    bases: await prisma.base.count(), units: await prisma.unit.count(), seats: await prisma.seat.count(),
    employees: await prisma.employee.count(), certifications: await prisma.certification.count(),
  };
  console.log('Seed complete:', counts);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
