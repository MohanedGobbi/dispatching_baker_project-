// Real data (2026-10-21): the operators, their ranks and the trucks from the manager's sheets, kept in
// prisma/real/crew.json. Replaces everything in the database except the settings.
// One base, no sites (the manager adds locations), no jobs, no assignments: the chiefs of each truck are linked as
// back-to-back partners and named in the truck's notes, nobody is put on a seat yet.
import '../src/env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { prepareDatabase, singleConnectionUrl, wipeDatabase } from '../src/prisma/migrate';
import { RANKS, RankCode } from '../src/employees/ranks';

const prisma = new PrismaClient({ datasourceUrl: singleConnectionUrl() });

interface Data {
  base: { code: string; name: string };
  people: { key: string; first: string; last: string; rank: RankCode }[];
  units: { code: string; pair: string[] }[];
}
const data: Data = JSON.parse(readFileSync(join(__dirname, 'real', 'crew.json'), 'utf8'));

async function main() {
  await prepareDatabase(prisma);
  // Keep the settings across the reset.
  const settings = await prisma.setting.findMany();

  await wipeDatabase(prisma);

  for (const s of settings) await prisma.setting.create({ data: { key: s.key, value: s.value as never } });
  // Rules warn instead of block: the manager can put anyone on any seat.
  await prisma.setting.upsert({ where: { key: 'rules.overrideReasonRequired' }, create: { key: 'rules.overrideReasonRequired', value: false }, update: { value: false } });

  // ---- Catalogs. Crews are a chief and three operators; nothing is required beyond the Open/Cased Hole skill.
  const qOH = await prisma.qualification.create({ data: { name: 'Open Hole' } });
  const qCH = await prisma.qualification.create({ data: { name: 'Cased Hole' } });
  for (const name of ['H2S', 'First aid', 'Heavy driving licence']) await prisma.certificationType.create({ data: { name } });
  // The company works 5 weeks on, 4 weeks off; the others are kept so a person can be put on a different cycle.
  const r3528 = await prisma.rotationPattern.create({ data: { name: '35/28', type: 'cycle', daysOn: 35, daysOff: 28 } });
  const r2828 = await prisma.rotationPattern.create({ data: { name: '28/28', type: 'cycle', daysOn: 28, daysOff: 28 } });
  await prisma.rotationPattern.create({ data: { name: '14/14', type: 'cycle', daysOn: 14, daysOff: 14 } });
  await prisma.rotationPattern.create({ data: { name: '21/7', type: 'cycle', daysOn: 21, daysOff: 7 } });
  const chief = await prisma.position.create({ data: { name: 'Chief of Unit', category: 'FIELD_CREW', canFillUnitSeat: true, defaultRotationId: r3528.id } });
  const operator = await prisma.position.create({ data: { name: 'Field Operator', category: 'FIELD_CREW', canFillUnitSeat: true, defaultRotationId: r3528.id } });
  for (const [name, category, needsDocument] of [
    ['Annual leave', 'leave', false], ['Medical leave', 'medical', true], ['Recovery days', 'leave', false], ['Training', 'training', false],
    ['Exceptional leave', 'leave', false], ['Unpaid leave', 'leave', false], ['Unjustified absence', 'absence', false],
  ] as const) {
    await prisma.leaveType.create({ data: { name, category, needsDocument, needsApproval: false } });
  }
  const oh = await prisma.unitType.create({ data: { name: 'Open Hole', colorKey: 'green' } });
  const ch = await prisma.unitType.create({ data: { name: 'Cased Hole', colorKey: 'amber' } });
  for (const [ut, q] of [[oh, qOH], [ch, qCH]] as const) {
    await prisma.crewTemplateSeat.createMany({ data: [
      { unitTypeId: ut.id, positionId: chief.id, count: 1, requiredQualId: q.id },
      { unitTypeId: ut.id, positionId: operator.id, count: 3, requiredQualId: q.id },
    ] });
  }

  // ---- The base
  const base = await prisma.base.create({ data: { code: data.base.code, name: data.base.name } });

  // ---- People. The rank decides the position and the level used by the crew rules; it is kept as the person's tag.
  // Hire dates are not in the sheets: today stands in until the manager enters them.
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const ids = new Map<string, string>();
  for (const [i, p] of data.people.entries()) {
    const rank = RANKS[p.rank];
    const e = await prisma.employee.create({ data: {
      employeeNo: `E${String(i + 1).padStart(3, '0')}`, firstName: p.first, lastName: p.last,
      positionId: rank.position === 'Chief of Unit' ? chief.id : operator.id, workMode: 'FIELD', hireDate: today,
      homeBaseId: base.id, rotationPatternId: r3528.id, seniorityOverride: rank.seniority, seniorityReason: `Rank: ${rank.label}`,
      tags: [rank.label],
      qualifications: { create: [qOH, qCH].map(q => ({ qualificationId: q.id, obtainedAt: today })) },
    } });
    ids.set(p.key, e.id);
  }

  // ---- Trucks. All start as Open Hole (change the type on the unit). Each truck's two chiefs work back-to-back.
  for (const u of data.units) {
    const pair = u.pair.map(k => { const id = ids.get(k); if (!id) throw new Error(`${u.code}: unknown person "${k}"`); return { k, id }; });
    const names = pair.map(x => { const p = data.people.find(pp => pp.key === x.k)!; return `${p.first} ${p.last}`; });
    const unit = await prisma.unit.create({ data: {
      code: u.code, unitTypeId: oh.id, homeBaseId: base.id,
      notes: names.length ? `Chiefs (back-to-back): ${names.join(' / ')}` : 'No chiefs named yet',
    } });
    await prisma.seat.createMany({ data: [
      { holderType: 'UNIT', unitId: unit.id, positionId: chief.id, index: 1, requirements: { qualification: qOH.name } },
      ...[1, 2, 3].map(index => ({ holderType: 'UNIT' as const, unitId: unit.id, positionId: operator.id, index, requirements: { qualification: qOH.name } })),
    ] });
    if (pair.length === 2) {
      await prisma.employee.update({ where: { id: pair[0].id }, data: { backToBackId: pair[1].id } });
      await prisma.employee.update({ where: { id: pair[1].id }, data: { backToBackId: pair[0].id } });
    }
  }

  const byRank = Object.fromEntries(Object.keys(RANKS).map(r => [RANKS[r as RankCode].label, data.people.filter(p => p.rank === r).length]));
  console.log('Real data loaded:', { base: base.name, units: await prisma.unit.count(), people: await prisma.employee.count(), byRank });
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
