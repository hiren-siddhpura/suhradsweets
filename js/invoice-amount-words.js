const ones = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function underThousand(number) {
  const parts = [];
  if (number >= 100) { parts.push(`${ones[Math.floor(number / 100)]} Hundred`); number %= 100; }
  if (number >= 20) { parts.push(`${tens[Math.floor(number / 10)]}${number % 10 ? `-${ones[number % 10]}` : ''}`); }
  else if (number) parts.push(ones[number]);
  return parts.join(' ');
}

function indianNumberWords(number) {
  if (number === 0) return 'Zero';
  const parts = [];
  for (const [size, label] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
    if (number >= size) { parts.push(`${underThousand(Math.floor(number / size))} ${label}`); number %= size; }
  }
  if (number) parts.push(underThousand(number));
  return parts.join(' ');
}

export function invoiceAmountWords(totalPaise) {
  const paise = Number(totalPaise);
  if (!Number.isSafeInteger(paise) || paise < 0 || Math.floor(paise / 100) > 999999999) throw new Error('Invoice total is too large to express in words.');
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return `Rupees ${indianNumberWords(rupees)}${remainder ? ` and ${indianNumberWords(remainder)} Paise` : ''} Only.`;
}
