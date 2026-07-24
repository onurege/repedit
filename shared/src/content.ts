// ============================================================
// V2.4 — static, data-driven player-experience content:
//   * release-notes updates ("What's New")
//   * the new-player tutorial script
// Both are locale-independent: the client maps ids/keys to EN/TR strings.
// ============================================================

/** A release-notes entry shown in "What's New" and the update history. */
export interface UpdateDef {
  id: string;          // stable id used for per-player seen-tracking
  version: string;
  titleKey: string;    // i18n key
  taglineKey: string;  // i18n key
  featureKeys: string[]; // i18n keys, one per bullet
}

// Newest first. Adding an entry makes it pop for players who haven't seen it.
export const UPDATES: UpdateDef[] = [
  {
    // V2.5.1 — balancing hotfix (import commodity availability). Small patch
    // note, not a feature release.
    id: 'v2_5_1',
    version: 'V2.5.1',
    titleKey: 'update.v2_5_1.title',
    taglineKey: 'update.v2_5_1.tagline',
    featureKeys: ['update.v2_5_1.f1'],
  },
  {
    id: 'v2_6',
    version: 'V2.6',
    titleKey: 'update.v2_6.title',
    taglineKey: 'update.v2_6.tagline',
    featureKeys: [
      'update.v2_6.f1', 'update.v2_6.f2', 'update.v2_6.f3',
      'update.v2_6.f4', 'update.v2_6.f5',
    ],
  },
  {
    id: 'v2_5',
    version: 'V2.5',
    titleKey: 'update.v2_5.title',
    taglineKey: 'update.v2_5.tagline',
    featureKeys: [
      'update.v2_5.f1', 'update.v2_5.f2', 'update.v2_5.f3', 'update.v2_5.f4',
    ],
  },
  {
    id: 'v2_4',
    version: 'V2.4',
    titleKey: 'update.v2_4.title',
    taglineKey: 'update.v2_4.tagline',
    featureKeys: [
      'update.v2_4.f1', 'update.v2_4.f2', 'update.v2_4.f3',
      'update.v2_4.f4', 'update.v2_4.f5',
    ],
  },
  {
    id: 'v2_3',
    version: 'V2.3',
    titleKey: 'update.v2_3.title',
    taglineKey: 'update.v2_3.tagline',
    featureKeys: ['update.v2_3.f1', 'update.v2_3.f2'],
  },
  {
    id: 'v2_2',
    version: 'V2.2',
    titleKey: 'update.v2_2.title',
    taglineKey: 'update.v2_2.tagline',
    featureKeys: ['update.v2_2.f1', 'update.v2_2.f2'],
  },
  {
    id: 'v2_1',
    version: 'V2.1',
    titleKey: 'update.v2_1.title',
    taglineKey: 'update.v2_1.tagline',
    featureKeys: ['update.v2_1.f1', 'update.v2_1.f2'],
  },
];

export const LATEST_UPDATE_ID = UPDATES[0].id;

/** One tutorial step. The client renders `messageKey` in Mira's dialog and
 *  optionally highlights `highlight` (a DOM id / nav target). */
export interface TutorialStepDef {
  step: number;
  titleKey: string;
  messageKey: string;
  highlight?: string;  // e.g. 'nav-biz', 'nav-market'
}

// Gentle, non-blocking progression. `step` is 1-based; 0 means "not started".
export const TUTORIAL_STEPS: TutorialStepDef[] = [
  { step: 1, titleKey: 'tut.1.title', messageKey: 'tut.1.msg' },
  { step: 2, titleKey: 'tut.2.title', messageKey: 'tut.2.msg', highlight: 'nav-biz' },
  { step: 3, titleKey: 'tut.3.title', messageKey: 'tut.3.msg', highlight: 'nav-biz' },
  { step: 4, titleKey: 'tut.4.title', messageKey: 'tut.4.msg', highlight: 'nav-biz' },
  { step: 5, titleKey: 'tut.5.title', messageKey: 'tut.5.msg' },
  { step: 6, titleKey: 'tut.6.title', messageKey: 'tut.6.msg', highlight: 'nav-biz' },
  { step: 7, titleKey: 'tut.7.title', messageKey: 'tut.7.msg', highlight: 'company-bar' },
  { step: 8, titleKey: 'tut.8.title', messageKey: 'tut.8.msg', highlight: 'nav-market' },
  { step: 9, titleKey: 'tut.9.title', messageKey: 'tut.9.msg', highlight: 'nav-contracts' },
];

export const TUTORIAL_LAST_STEP = TUTORIAL_STEPS.length;

// ---- Announcement enums (shared so client & server agree on the vocabulary) ----
export type AnnouncementType = 'general' | 'update' | 'event' | 'maintenance' | 'critical';
export type AnnouncementPriority = 'normal' | 'important' | 'critical';

export const ANNOUNCEMENT_TITLE_MAX = 80;
export const ANNOUNCEMENT_MESSAGE_MAX = 500;

// ---- Business alerts & opportunities (locale-independent codes) ----
export type AlertKind =
  | 'low_stock'
  | 'sold_out'
  | 'missed_contract'
  | 'not_operating'
  | 'capacity_full';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type OpportunityKind =
  | 'event_stock_up'
  | 'high_demand_produce'
  | 'supplier_demand'
  | 'first_upgrade'
  | 'join_market';
