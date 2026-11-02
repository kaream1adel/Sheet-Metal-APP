// المبلغ بالحروف (تفقيط) for the printed إيصال استلام نقدية and إذن صرف:
//   amountWords(1235500) → «فقط ألف ومائتان وخمسة وثلاثون جنيهًا وخمسون قرشًا لا غير»
// Input is millimes (1 EGP = 1000); piastres are rounded half-up like the displayed amount.
// Pure (no DOM): the tests import it on the server too.

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function below100(n) {
  if (n <= 10) return ONES[n];
  if (n === 11) return 'أحد عشر';
  if (n === 12) return 'اثنا عشر';
  if (n < 20) return `${ONES[n - 10]} عشر`;
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${ONES[o]} و${TENS[t]}` : TENS[t];
}

function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [HUNDREDS[h], r ? below100(r) : ''].filter(Boolean).join(' و');
}

// [one, two, few (3-10), many (11+)]
const SCALES = [
  [1e9, ['مليار', 'ملياران', 'مليارات', 'مليار']],
  [1e6, ['مليون', 'مليونان', 'ملايين', 'مليون']],
  [1e3, ['ألف', 'ألفان', 'آلاف', 'ألف']],
];

function group(count, [one, two, few, many]) {
  if (count === 1) return one;
  if (count === 2) return two;
  if (count >= 3 && count <= 10) return `${below100(count)} ${few}`;
  return `${below1000(count)} ${many}`;
}

export function numberWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'صفر';
  const parts = [];
  let rest = n;
  for (const [size, names] of SCALES) {
    const c = Math.floor(rest / size);
    if (c) parts.push(group(c, names));
    rest %= size;
  }
  if (rest) parts.push(below1000(rest));
  return parts.join(' و');
}

// The counted noun after a number (Arabic agreement by the last two digits).
function counted(n, [one, two, few, many]) {
  if (n === 1) return `${one} واحد`;
  if (n === 2) return two;
  const last2 = n % 100;
  if (last2 >= 3 && last2 <= 10) return `${numberWords(n)} ${few}`;
  if (last2 >= 11 && last2 <= 99) return `${numberWords(n)} ${many}`;
  return `${numberWords(n)} ${one}`;
}
const POUND = ['جنيه', 'جنيهان', 'جنيهات', 'جنيهًا'];
const PIASTRE = ['قرش', 'قرشان', 'قروش', 'قرشًا'];

export function amountWords(millimes) {
  const m = Math.abs(Number(millimes) || 0);
  const piastres = Math.floor((m + 5) / 10);
  const pounds = Math.floor(piastres / 100);
  const pt = piastres % 100;
  if (!pounds && !pt) return 'صفر جنيه';
  const parts = [];
  if (pounds) parts.push(counted(pounds, POUND));
  if (pt) parts.push(counted(pt, PIASTRE));
  return `فقط ${parts.join(' و')} لا غير`;
}
