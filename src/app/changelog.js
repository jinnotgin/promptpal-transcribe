// Newest release first. `version` is the short display form (see formatVersion);
// `date` is the release day as YYYY-MM-DD.
export const CHANGELOG = [
  {
    version: "2",
    date: "2026-10-12",
    title: "More languages, more speakers",
    changes: [
      {
        lead: "Chinese support.",
        detail:
          "You can now transcribe Chinese, and English and Chinese mixed together, from uploaded files or the microphone.",
      },
      {
        lead: "Speaker labels for up to 8 speakers, up from 4.",
        detail:
          "For bigger groups, you can set up to 26 speakers, but the labels will be less accurate.",
      },
      {
        lead: "New name and look: shhsaid.",
        detail: "Your history and settings carry over.",
      },
    ],
  },
  {
    version: "1",
    date: "2026-07-11",
    title: "Private transcription in your browser",
    changes: [
      {
        lead: "Nothing leaves your device.",
        detail:
          "Audio is transcribed in your browser and never uploaded. There's no account or sign-in.",
      },
      {
        lead: "Upload a recording or use the microphone,",
        detail: "and the transcript appears as you go.",
      },
      { lead: "Speaker labels", detail: "for up to 4 speakers." },
      {
        lead: "History you can revisit.",
        detail:
          "Past transcripts and their audio are kept in your browser, with playback alongside the text.",
      },
      { lead: "English only." },
    ],
  },
];

export function formatReleaseDate(date, now = new Date()) {
  // Parse as UTC and format in UTC so the day never shifts with the viewer's zone.
  const releasedAt = new Date(`${date}T00:00:00Z`);
  const sameYear = releasedAt.getUTCFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  }).format(releasedAt);
}
