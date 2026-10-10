// House upgrade rules: status checklist, manual request, auto-upgrade toggle. Pure: no DOM, no globals.
import { HOUSE_LEVELS, NEED_INFO } from './config.js';
import { missingFor } from './economy.js';
import { pushEvent } from './events.js';
import { evaluateHouse } from './needs.js';

// Starts the upgrade work for a house (materials are then hauled by builders).
export function startUpgrade(state, house) {
  const next = HOUSE_LEVELS[house.level];
  house.upgrading = true;
  house.needed = { ...next.upgradeCost };
  house.incoming = {};
  house.progress = 0;
  pushEvent(state, `บ้านกำลังอัปเกรดเป็น${next.name}`);
}

function blockReason(house, needs) {
  if (!house.built) return 'บ้านยังสร้างไม่เสร็จ';
  if (house.upgrading) return 'กำลังอัปเกรดอยู่';
  const lacking = needs.filter((n) => !n.met).map((n) => n.name);
  return lacking.length > 0 ? `ยังขาด: ${lacking.join(', ')}` : '';
}

// Checklist for the NEXT level, based on the house's current needsMet.
export function upgradeStatus(state, house) {
  const level = house.level;
  const next = HOUSE_LEVELS[level];
  if (!next) {
    return { level, nextLevel: null, nextName: null, needs: [], cost: {}, missing: {},
      canUpgrade: false, reason: 'ระดับสูงสุดแล้ว' };
  }
  const needs = next.needs.map((key) => ({ key, name: NEED_INFO[key] ?? key, met: house.needsMet?.[key] === true }));
  const cost = { ...next.upgradeCost };
  const reason = blockReason(house, needs);
  return {
    level, nextLevel: level + 1, nextName: next.name, needs, cost, missing: missingFor(state, cost),
    canUpgrade: reason === '', reason,
  };
}

export function requestUpgrade(state, houseId) {
  const house = state.buildings.find((b) => b.id === houseId);
  if (!house || house.type !== 'house') return { ok: false, reason: 'ไม่พบบ้าน' };
  if (house.built) evaluateHouse(state, house);   // make sure the checklist is fresh
  const status = upgradeStatus(state, house);
  if (!status.canUpgrade) return { ok: false, reason: status.reason };
  startUpgrade(state, house);
  return { ok: true, reason: '' };
}

// houseId null = every house.
export function setAutoUpgrade(state, houseId, on) {
  for (const b of state.buildings) {
    if (b.type === 'house' && (houseId == null || b.id === houseId)) b.autoUpgrade = on === true;
  }
}
