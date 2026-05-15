/**
 * ISO / DB datetime → reader-friendly local date+time (browser locale & timezone).
 */
export function formatDateTimeWithSeconds(raw: unknown): string {
    const t = String(raw ?? '').trim();
    if (!t) return '';
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return t;
    try {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'medium',
        }).format(d);
    } catch {
        return d.toLocaleString();
    }
}
