import {
  experimental_Icon,
  type ExperimentalIconProps,
} from "@get-bb/plugin-sdk/app";

export type IconName = string;
export type IconProps = ExperimentalIconProps;

// The host's icon catalog, bb 0.49.0. The SDK has no list (BbIconName is `string`), and a missing name draws the
// call's `fallback`, or the host's Zap when there is none. Regenerate from
// ~/.bb/app-versions/<ver>/node_modules/bb-app/app/dist/assets/index-*.js: the base set is the keys of the object
// literal ending in `},_c=[...Object.keys(gc)`, the extended set is the dot-joined string beginning `AiBrain01.AiBrowser`
// (its artwork is the `[[tag, attrs]]` arrays in workspace-route-*.js). Only 0.49.0 was checked, while engines.bb is
// >=0.48: names outside the base set may be missing on older hosts.
export const HOST_ICON_BASE: ReadonlySet<string> = new Set([
  "AlertCircle", "AlertTriangle", "Archive", "Bot", "Bug", "Check", "ChevronDown", "ChevronLeft", "ChevronRight",
  "Circle", "CircleCheck", "CircleQuestion", "CircleX", "ClosePluginPane", "CloseThreadPane", "Code",
  "ComputerTerminal01", "Copy", "Download", "Edit", "Filter", "FilterHorizontal", "Folder", "Folder02",
  "FolderExport", "FolderGit", "FolderPlus", "FolderSync", "FolderUnknown", "Home", "Info", "ListTodo", "Loading",
  "MessageCirclePlus", "MessageQuestion", "MessageSquare", "MessageSquarePlus", "MoreHorizontal", "PanelLeft",
  "Search", "SectionAdd", "SectionMove", "Settings", "SlidersHorizontal", "Spinner", "Target", "Terminal",
  "ToolCase", "Toolbox", "Trash2", "Unavailable", "UserRoundPlus", "Workflow", "X", "Zap",
]);
export const HOST_ICON_CATALOG: ReadonlySet<string> = new Set([
  ...HOST_ICON_BASE,
  "AiBrain01", "AiBrowser", "AiContentGenerator01", "AlignLeft", "AppWindow", "ArchiveRestore", "ArrowDown",
  "ArrowLeft", "ArrowReloadHorizontal", "ArrowRight", "ArrowTurnBackward", "ArrowTurnForward", "ArrowUp",
  "ArrowUpDown", "ArrowUpRight", "Beaker", "BellDot", "Brain", "Browser", "Calendar", "CalendarCheckOut02",
  "ChartColumn", "ChevronUp", "ChevronsDown", "ChevronsUp", "ChildThread", "CircleArrowShrink", "Clean", "Clock",
  "ClockArrowDown", "ClockArrowUp", "Cloud", "CloudOff", "Coffee", "Columns2", "ComputerCloud", "CornerDownLeft",
  "CornerDownRight", "DateTime", "DiffAdded", "DiffConflict", "DiffModified", "DiffRemoved", "DiffRenamed",
  "Discord", "DiscordLogo", "DragDropHorizontal", "DragDropVertical", "EditFile", "ElectricPlugs", "Explore",
  "ExternalLink", "Eye", "EyeOff", "File", "FileAttachment", "FileDiff", "FileQuestion", "FileText", "FolderEdit",
  "FolderMinus", "FolderOpen", "Fork", "GitBranch", "GitMerge", "GitPullRequest", "GitPullRequestArrow",
  "GitPullRequestClosed", "GitPullRequestDraft", "Github", "GithubLogo", "Globe", "GridView", "Keyboard", "Laptop",
  "Layers", "LayoutList", "Limitation", "Link", "ListEnd", "ListView", "Lock", "Mail", "MailOpen", "Maximize2",
  "Megaphone02", "Mic", "Minimize2", "Minus", "MoveTo", "NewTab", "News01", "PackageReceive", "Palette",
  "PanelBottom", "PanelRight", "Paperclip", "Pause", "Pin", "PinOff", "Play", "Plug02", "Plus", "Puzzle", "Repeat",
  "RotateCcw", "Rows2", "SecurityCheck", "Sent", "SideChat", "Smartphone", "Sort", "SortingAZ02", "SortingNineOne",
  "SortingOneNine", "SortingZA01", "Space", "Square", "SquareUnlock02", "Star", "TextWrap", "TimeSchedule",
  "UserRound", "ZoomIn", "ZoomOut",
]);

// The host has its own icon catalog (above), not the full Lucide catalog. Translate the Lucide names our UI uses
// into host names, or into plugin icons (`chief-of-staff/<key>`, package.json bb.branding.experimental_icons), so
// none draws its fallback. tests/hostIcons.test.ts checks every name the source requests against the catalog.
export const HOST_ICON_NAMES: Record<string, string> = {
  // A pulse: when a task last did something. ChartColumn is Throughput.
  Activity: "chief-of-staff/activity",
  ArrowDownToLine: "Download",
  ArrowUpFromLine: "ArchiveRestore",
  BarChart3: "ChartColumn",
  Bell: "BellDot",
  BellRing: "BellDot",
  CalendarCheck: "CalendarCheckOut02",
  Braces: "Code",
  // The canvas "Tidy" button. GridView is the "All" filter.
  BrushCleaning: "Clean",
  ChefHat: "chief-of-staff/chef-hat",
  CircleAlert: "AlertCircle",
  CircleDot: "CircleCheck",
  ClipboardCheck: "ListTodo",
  Cog: "Settings",
  // Cost. Layers is Task slots.
  Coins: "chief-of-staff/coins",
  Command: "Terminal",
  Ellipsis: "MoreHorizontal",
  FlaskConical: "Beaker",
  FolderGit2: "FolderGit",
  Gauge: "Limitation",
  Hand: "UserRound",
  History: "TimeSchedule",
  // Stalled needs the user; the host has no hourglass, and its Clock is a task's age and Pause means paused.
  Hourglass: "chief-of-staff/hourglass",
  Inbox: "PackageReceive",
  KeyRound: "Lock",
  LayoutGrid: "GridView",
  List: "ListView",
  ListChecks: "LayoutList",
  ListFilter: "FilterHorizontal",
  MessageCircleQuestion: "MessageQuestion",
  // "No report": the step ended without its report. MessageQuestion stays the agent's question.
  MessageSquareWarning: "FileQuestion",
  MousePointerClick: "Target",
  // The Activity panel: a feed of what happened.
  Newspaper: "News01",
  Network: "Workflow",
  // "CoS stuck". AlertCircle stays a card's error line and the serious tone.
  OctagonAlert: "chief-of-staff/octagon-alert",
  RefreshCw: "ArrowReloadHorizontal",
  Rocket: "ArrowUpRight",
  Save: "Check",
  SearchCheck: "Search",
  Send: "Sent",
  ShieldCheck: "SecurityCheck",
  ShieldQuestion: "CircleQuestion",
  // A skill reference in an instructions box: a piece the agent can pick up.
  Sparkles: "Puzzle",
  SquareCheck: "Check",
  // Throughput's table view: rows. GridView is the "All" filter.
  Table: "Rows2",
  Tag: "Filter",
  Timer: "Clock",
  // The Throughput panel. Its chart switch is ChartColumn.
  TrendingUp: "chief-of-staff/trending-up",
  TriangleAlert: "AlertTriangle",
  Undo2: "ArrowTurnBackward",
  // Hand-marked outcomes: the host's only person icon (UserRound) already stands for "Your call".
  UserCheck: "chief-of-staff/user-check",
  UserX: "chief-of-staff/user-x",
  Wrench: "Toolbox",
};

/** The host catalog's name for an icon name used by our UI. */
export function hostIconName(name: string): string {
  return HOST_ICON_NAMES[name] ?? name;
}

export function Icon({ name, fallback, ...props }: IconProps) {
  const HostIcon = experimental_Icon;
  return (
    <HostIcon
      name={hostIconName(name)}
      fallback={fallback ? hostIconName(fallback) : undefined}
      {...props}
    />
  );
}
