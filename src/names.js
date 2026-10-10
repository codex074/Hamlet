// Name lists (Thai-script medieval European names). Pure data + tiny helpers: no DOM, no globals.

export const MALE_NAMES = [
  'โธมัส', 'วิลเลียม', 'เฮนรี่', 'จอห์น', 'ริชาร์ด', 'โรเบิร์ต', 'ฮิวจ์', 'วอลเตอร์', 'ราล์ฟ', 'ไซมอน',
  'ปีเตอร์', 'จอฟฟรีย์', 'ไมเคิล', 'นิโคลัส', 'อดัม', 'เจมส์', 'เอ็ดมันด์', 'เอ็ดเวิร์ด', 'ฟิลิป', 'สตีเฟน',
  'เบนจามิน', 'แดเนียล', 'ดาวิด', 'ลูคัส', 'มาร์ติน', 'อัลเบิร์ต', 'เจอรัลด์', 'ออสวัลด์', 'เบอร์นาร์ด', 'ยูสเตซ',
  'กิลเบิร์ต', 'ฮาโรลด์', 'ลอว์เรนซ์', 'แอนดรูว์',
];

export const FEMALE_NAMES = [
  'แอนนา', 'มาร์กาเร็ต', 'อลิซ', 'โจน', 'อักเนส', 'เอ็มมา', 'อิซาเบล', 'ม็อด', 'เบียทริซ', 'เซซิลี',
  'เอลีนอร์', 'แคทเธอรีน', 'ซาราห์', 'เอลิซาเบธ', 'มาทิลดา', 'ฮันนาห์', 'จูเลียน่า', 'โรสมันด์', 'ซิบิล', 'ลูซี่',
  'มาร์เจอรี', 'เอดิธ', 'ฟิลิปปา', 'อลิเซีย', 'เกอร์ทรูด', 'ไอดา', 'ลิเดีย', 'แมรี่', 'คริสตินา', 'โดโรธี',
  'เฮเลน', 'เวอร์จิเนีย', 'วิกตอเรีย', 'ไอวี่',
];

export const SURNAMES = [
  'มิลเลอร์', 'สมิธ', 'คูเปอร์', 'เบเกอร์', 'ฟิชเชอร์', 'เทย์เลอร์', 'คาร์เตอร์', 'ฟลีทเชอร์', 'มาร์แชลล์', 'ทาวเวอร์',
  'ฮันเตอร์', 'วีเวอร์', 'ไรท์', 'แมสัน', 'ฟาร์เมอร์', 'ชาเปิล', 'ฮิลล์', 'วูด', 'บรู๊ค', 'ฟอสเตอร์',
  'แอชตัน', 'เบลีย์', 'ฮาร์เปอร์', 'กรีน', 'สโตน', 'เวสต์', 'คลาร์ก', 'ฮอลล์', 'ไวท์', 'ฟอร์ด',
];

export function pickGivenName(gender, rand) {
  const list = gender === 'f' ? FEMALE_NAMES : MALE_NAMES;
  return list[Math.floor(rand() * list.length) % list.length];
}

// `avoid` (optional): surnames already taken, tried to be distinct.
export function pickSurname(rand, avoid = []) {
  const free = SURNAMES.filter((s) => !avoid.includes(s));
  const list = free.length > 0 ? free : SURNAMES;
  return list[Math.floor(rand() * list.length) % list.length];
}

export function fullName(v) {
  return v.surname ? `${v.name} ${v.surname}` : String(v.name ?? '');
}
