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

  // 2026
  '2026-01-26': 'Republic Day',
  '2026-02-17': 'Mahashivratri',
  '2026-03-03': 'Holi',
  '2026-03-20': 'Id-Ul-Fitr (Ramadan)',
  '2026-03-30': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-27': 'Id-Ul-Zuha (Bakri Id)',
  '2026-06-26': 'Muharram',
  '2026-08-15': 'Independence Day',
  '2026-08-16': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-09': 'Dussehra',
  '2026-10-29': 'Diwali Laxmi Pujan',
  '2026-10-30': 'Diwali Balipratipada',
  '2026-11-16': 'Prakash Gurpurb Sri Guru Nanak Dev',
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

export default { isMarketHoliday, isTradingDay };
