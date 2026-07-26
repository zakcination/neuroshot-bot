/**
 * What changed, in the user's words.
 *
 * Shown INSIDE the app on the next open — never pushed. A release note is not
 * worth a slot in the weekly message budget (config.pushPerWeek): the people
 * who care are the ones already opening the app, and the ones who aren't would
 * only learn that we message them about our own work.
 *
 * Rules for writing an entry:
 *  - describe what the USER can now do, not what we refactored;
 *  - drop anything they cannot see (migrations, tests, docs, guards);
 *  - if a release changed nothing visible, ship no entry — a changelog padded
 *    with invisible work teaches people to stop reading it.
 *
 * `id` must sort ascending and never be reused: it is what "seen" is stored
 * against, so renumbering would re-show old notes to everyone.
 */
export interface ReleaseNote {
  id: string; // YYYY-MM-DD[-n], ascending, never reused
  title: string;
  lines: string[];
}

export const RELEASES: ReleaseNote[] = [
  {
    id: "2026-07-26",
    title: "Уровни, достижения и честные оплаты",
    lines: [
      "🏅 Появились достижения — 17 значков за то, что вы уже делали. Считаются задним числом, так что часть у вас уже есть.",
      "🎚 Уровень и опыт видны прямо в шапке: XP прилетает от готовой работы к шкале.",
      "🎬 Кнопка «Оживить в видео» теперь под любой картинкой, а не только под сценариями.",
      "🛍 Из списка стилей можно переключиться на съёмку товара и обратно — фото загружать заново не нужно.",
      "✨ «Улучшить промпт» стал стеком на 2 попытки, и кнопка наконец показывает, сколько осталось.",
      "🤝 В разделе «Друзья» видно, сколько ваши приглашённые реально оплатили и сколько начислено вам.",
      "📄 Условия, возврат и данные продавца доступны прямо в боте: /terms, /refund, /privacy.",
    ],
  },
];

/** Notes the user has not seen yet, newest first. */
export function unseenReleases(seenId: string | null): ReleaseNote[] {
  const sorted = [...RELEASES].sort((a, b) => (a.id < b.id ? 1 : -1));
  if (!seenId) return sorted;
  return sorted.filter((r) => r.id > seenId);
}

/** The newest release id — what gets stored once the user has read the notes. */
export function latestReleaseId(): string | null {
  return RELEASES.reduce<string | null>((max, r) => (max == null || r.id > max ? r.id : max), null);
}
