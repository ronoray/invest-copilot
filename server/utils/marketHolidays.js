/**
 * NSE Market Holiday Calendar
 * Source: Official NSE holiday list (updated annually)
 * Format: 'YYYY-MM-DD' => 'Holiday Name'
 */

const NSE_HOLIDAYS = {
  // 2025
  '2025-02-26': 'Mahashivratri',
  '2025-03-14': 'Holi',
  '2025-03-31': 'Id-Ul-Fitr (Ramadan)',
  '2025-04-10': 'Shri Mahavir Jayanti',
  '2025-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2025-04-18': 'Good Friday',
  '2025-05-01': 'Maharashtra Day',
  '2025-08-15': 'Independence Day',
  '2025-08-27': 'Ganesh Chaturthi',
  '2025-10-02': 'Mahatma Gandhi Jayanti',
  '2025-10-21': 'Diwali Laxmi Pujan',
  '2025-10-22': 'Diwali Balipratipada',
  '2025-11-05': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2025-11-26': 'Constitution Day (tentative)',
  '2025-12-25': 'Christmas',

  // 2026 — Source: NSE official circular, Groww, Zerodha
  // Mahashivratri (Feb 15) falls on Sunday — not a trading holiday
  '2026-01-15': 'Municipal Corporation Election - Maharashtra',
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Id-Ul-Zuha (Bakri Id)',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali Balipratipada',
  '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2026-12-25': 'Christmas',
};

/**
 * Check if a given date is an NSE market holiday.
 * @param {Date} date
 * @returns {{ isHoliday: boolean, name: string|null }}
 */
export function isMarketHoliday(date) {
  const key = formatDateKey(date);
  const name = NSE_HOLIDAYS[key] || null;
  return { isHoliday: !!name, name };
}

/**
 * Check if a given date is a trading day (not weekend, not holiday).
 * @param {Date} date
 * @returns {boolean}
 */
export function isTradingDay(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false; // Weekend
  return !isMarketHoliday(date).isHoliday;
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns the UTC timestamp corresponding to IST midnight (00:00:00 IST) for the
 * current IST calendar day.
 *
 * Why this matters: `new Date().setHours(0,0,0,0)` gives UTC midnight = 05:30 AM IST.
 * Evening playbook signals are created at ~7:30 PM IST (= ~14:00 UTC on day D).
 * If next-morning dedup uses UTC midnight of day D+1 as the boundary, those signals
 * fall outside the window and the system treats the morning as signal-free — generating
 * duplicates.
 *
 * IST is UTC+5:30. IST midnight = UTC 18:30 of the previous calendar day.
 *
 * @returns {Date} UTC Date representing IST 00:00:00 today
 */
export function getISTMidnight() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30
  const nowUtc = Date.now();
  // Shift current time into IST "virtual UTC"
  const istNow = new Date(nowUtc + IST_OFFSET_MS);
  // Midnight in IST virtual-UTC
  const istMidnightVirtual = new Date(Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    0, 0, 0, 0
  ));
  // Shift back to real UTC
  return new Date(istMidnightVirtual.getTime() - IST_OFFSET_MS);
}

/** Format a Date as "YYYY-MM-DD HH:mm:ss IST" for API responses and logs. */
export function toISTString(date = new Date()) {
  return new Date(date).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }) + ' IST';
}

export default { isMarketHoliday, isTradingDay, getISTMidnight, toISTString };
