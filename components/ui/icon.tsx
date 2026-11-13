import {
  experimental_Icon,
  type ExperimentalIconProps,
} from "@get-bb/plugin-sdk/app";

export type IconName = string;
export type IconProps = ExperimentalIconProps;

// The host has its own icon catalog, not the full Lucide catalog. Translate
// names used by our UI so missing artwork doesn't become a Circle fallback.
const HOST_ICON_NAMES: Record<string, string> = {
  Activity: "ChartColumn",
  BarChart3: "ChartColumn",
  Bell: "BellDot",
  BellRing: "BellDot",
  Braces: "Code",
  ChefHat: "chief-of-staff/chef-hat",
  CircleAlert: "AlertCircle",
  CircleDot: "CircleCheck",
  ClipboardCheck: "ListTodo",
  Cog: "Settings",
  Coins: "Layers",
  Command: "Terminal",
  Ellipsis: "MoreHorizontal",
  FlaskConical: "Beaker",
  FolderGit2: "FolderGit",
  Gauge: "ChartColumn",
  Hand: "UserRound",
  History: "TimeSchedule",
  Hourglass: "Clock",
  Inbox: "PackageReceive",
  KeyRound: "Lock",
  LayoutGrid: "GridView",
  List: "ListView",
  MessageCircleQuestion: "MessageQuestion",
  MessageSquareWarning: "MessageQuestion",
  MousePointerClick: "Target",
  Network: "Workflow",
  OctagonAlert: "AlertCircle",
  RefreshCw: "ArrowReloadHorizontal",
  Rocket: "ArrowUpRight",
  Save: "Check",
  SearchCheck: "Search",
  Send: "Sent",
  ShieldCheck: "SecurityCheck",
  ShieldQuestion: "CircleQuestion",
  SquareCheck: "Check",
  Table: "GridView",
  Tag: "Filter",
  Timer: "Clock",
  TriangleAlert: "AlertTriangle",
  Undo2: "ArrowTurnBackward",
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
