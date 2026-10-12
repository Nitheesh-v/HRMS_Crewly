// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE — icon registry.
//
// landingData.js stays JSX-free (the tests import it), so it names icons by key
// and this file is the only place that turns a key into a component. An unknown
// key renders nothing rather than crashing the page.
// ═══════════════════════════════════════════════════════════════════════════
import {
  Activity,
  BarChart3,
  CalendarCheck,
  CalendarDays,
  CreditCard,
  Database,
  FileText,
  KeyRound,
  Lock,
  Megaphone,
  MessageSquare,
  Monitor,
  Plane,
  Receipt,
  RefreshCcw,
  ScrollText,
  Send,
  Shield,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  Video,
} from 'lucide-react';

export const ICONS = {
  activity: Activity,
  barChart: BarChart3,
  calendar: CalendarDays,
  calendarCheck: CalendarCheck,
  creditCard: CreditCard,
  database: Database,
  fileText: FileText,
  key: KeyRound,
  lifecycle: RefreshCcw,
  lock: Lock,
  megaphone: Megaphone,
  message: MessageSquare,
  monitor: Monitor,
  plane: Plane,
  profileChange: FileText,
  receipt: Receipt,
  rupee: CreditCard,
  scroll: ScrollText,
  send: Send,
  shield: Shield,
  shieldCheck: ShieldCheck,
  sparkles: Sparkles,
  userPlus: UserPlus,
  users: Users,
  video: Video,
  workMode: Monitor,
};

const LandingIcon = ({ name, className = 'h-5 w-5' }) => {
  const Icon = ICONS[name];

  if (!Icon) return null;

  return <Icon className={className} aria-hidden="true" />;
};

export default LandingIcon;
