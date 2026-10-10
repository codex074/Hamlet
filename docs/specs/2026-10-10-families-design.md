# Hamlet — Families, Ageing & Births (Design Spec v3)

Extends the professions spec (v2). Approved by the user 2026-10-10.

## 1. Time & life stages
- 1 game day = 1 year of age. `age` grows continuously: `age += dt / DAY_LENGTH`.
- Stages (config): child `< CHILD_AGE (14)`, adult, elder `>= ELDER_AGE (55)`. Each villager gets `deathAge` uniformly in [DEATH_AGE_MIN 70, DEATH_AGE_MAX 85] at creation.
- When `age >= deathAge` the villager passes away: removed like leaving (release reservations, residents, workers, spouse.spouseId = null) with event `🕊️ <name> จากไปอย่างสงบในวัย N ปี`.

## 2. Villager fields (added)
`name` (given name), `surname`, `gender: 'm'|'f'`, `age`, `deathAge`, `spouseId|null`, `parents: [id]`, `children: [id]`, `pregnant: boolean`, `pregnantDays: number`.

Names: Thai-script medieval European given names — ≥ 30 male (e.g. โธมัส, วิลเลียม, เฮนรี่, จอห์น, ริชาร์ด, โรเบิร์ต, ฮิวจ์, วอลเตอร์, ราล์ฟ, ไซมอน, ปีเตอร์, จอฟฟรีย์, ไมเคิล, นิโคลัส, อดัม, ...) and ≥ 30 female (แอนนา, มาร์กาเร็ต, อลิซ, โจน, อักเนส, เอ็มมา, อิซาเบล, ม็อด, เบียทริซ, เซซิลี, เอลีนอร์, ...); ≥ 25 surnames (มิลเลอร์, สมิธ, คูเปอร์, เบเกอร์, ฟิชเชอร์, เทย์เลอร์, คาร์เตอร์, ฟลีทเชอร์, ...). Children take the father's surname. Lists live in `src/names.js`.

## 3. Work eligibility
- Cannot work or build: children, pregnant women, sick villagers.
- Elders: only buildings with `light: true` in BUILDINGS (add the flag to: chapel, tavern, market, infirmary, herbalist, weaver, bakery, forager). Elders never act as builders/haulers; idle elders wander/rest.
- Job assignment skips ineligible villagers and unassigns a worker who becomes ineligible (aged into elder at a heavy job, pregnant, child never assigned). Builder reserve counts only eligible adults.
- Speed multipliers: elders × ELDER_SPEED_MUL (0.75), children × CHILD_SPEED_MUL (0.9), pregnant × 0.8.
- Children by day: play/wander within 12 m of home (or townhall), eat as normal, sleep at night.

## 4. Marriage (each midnight)
- Eligible singles: age MARRY_MIN 18 … MARRY_MAX 45, not sick, spouseId null. Pair opposite genders, not parent/child or siblings (shared parent). Each eligible woman marries the closest eligible man with probability MARRY_CHANCE (0.35) per night.
- Household: the couple must share a home. Prefer the husband's house if it has room for the wife, else the wife's house if it has room, else both become homeless (keeping their spouse link) so `assignHomes` houses them together.
- Event `💍 <name> แต่งงานกับ <name>`.

## 5. Pregnancy & birth
- At midnight a married woman aged FERTILE_MIN 18 … FERTILE_MAX 42, not pregnant, not sick, whose home has `residents < capacity` and house happiness >= 0.5 becomes pregnant with PREGNANCY_CHANCE (0.3). Event `🤰 <name> ตั้งครรภ์`.
- `pregnantDays` counts midnights; after PREGNANCY_DAYS (2) she gives birth: new villager age 0, random gender, parents [mother, father], surname = father's (or mother's if no father), home = mother's home (residents may exceed capacity by the newborn — babies always stay with the mother), position near the mother. Event `👶 ครอบครัว<surname>มีลูกคนใหม่ชื่อ <name>`.
- Children's `children` arrays updated on both parents.

## 6. Leaving home & housing families
- At midnight an unmarried adult aged >= LEAVE_HOME_AGE (18) living with a parent moves out (becomes homeless) if the house is at or over capacity.
- `assignHomes` houses groups: a married couple + their children under CHILD_AGE move as one unit into a house with enough free capacity; singles fill remaining places. Children are never housed apart from a parent.
- `planHouses` counts families as units when deciding whether more houses are needed.

## 7. Immigration & start
- Start: 3 married couples (ages 20–35, distinct surnames) + 2 single adults (18–30) = 8 adults.
- Immigrants: with 50% chance a group is a family (couple 20–40 + 0–2 children 1–12), otherwise single adults 18–40. Same daily immigration rules; count per night as before (children count toward the total).
- Initial `deathAge` assigned for everyone.

## 8. API (sim.js)
- `villagerAt(state, x, z, maxDist = 1.5) -> villager|null` (nearest villager to a ground point).
- `villagerInfo(state, id) -> { id, name, surname, fullName, gender, age (int), stage: 'child'|'adult'|'elder', status: [ 'sick'|'pregnant'|'sleeping'|'working'|'idle'|'builder' ], job: {id, type, name}|null, home: {id, level}|null, spouse: {id, name}|null, parents: [{id,name,alive}], children: [{id,name,age}], grandchildren: [{id,name,age}] }`.
- `household(state, houseId) -> [{ id, fullName, age, gender, stage, relation: 'หัวหน้าครอบครัว'|'คู่สมรส'|'ลูก'|'หลาน'|'พ่อ'|'แม่'|'ผู้อาศัย', status: [...] }]`.
- `summary()` adds `children`, `elders`, `pregnant`, `births` (total), `deaths` (total).

## 9. Save
- version 3. v2 → v3 migration: each villager gets gender (random by id), age 18–50, deathAge, names; residents of the same house are paired into couples (one m + one f where possible), extra residents become their children only if ages allow, otherwise plain housemates.

## 10. UI & render
- House panel: "ครอบครัว<surname>" member list from `household()` with ♂/♀, age, relation and status icons (👶 เด็ก, 🤰, 👴/👵, 🤒, 🔨 ทำงาน).
- Click a villager (world.js `pickVillager(raycaster)` → id, nearest villager within 1.2 m of the ray) → villager panel from `villagerInfo()` with family links (click a relative to select them; camera does not move).
- Top bar population tooltip: ผู้ใหญ่ / เด็ก / ผู้สูงอายุ / ตั้งครรภ์.
- Guide: new section '👪 ครอบครัวและอายุ' (numbers from config).
- Render (done by Claude): gendered looks, child scaling, elder stoop + cane, pregnancy belly — driven by `gender`, `age`, `pregnant`.
