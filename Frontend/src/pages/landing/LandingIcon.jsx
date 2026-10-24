// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — icon registry.
//
// landingData.js stays JSX-free (the tests import it), so it names icons by key
// and this file is the only place that turns a key into a component. An unknown
// key renders nothing rather than crashing the page.
// ═══════════════════════════════════════════════════════════════════════════
import {
  Activity,
  BarChart3,
  Briefcase,
  CalendarCheck,
  CalendarDays,
  CreditCard,
  Database,
  FileText,
  KeyRound,
  Languages,
  Lock,
  Mail,
  Megaphone,
  MessageSquare,
  Monitor,
  Plane,
  QrCode,
  Receipt,
  RefreshCcw,
  ScrollText,
  Send,
  Shield,
  ShieldCheck,
  Sparkles,
  TabletSmartphone,
  Upload,
  UserCircle,
  UserPlus,
  Users,
  Video,
} from 'lucide-react';

const ICONS = {
  activity: Activity,
  barChart: BarChart3,
  briefcase: Briefcase,
  calendar: CalendarDays,
  calendarCheck: CalendarCheck,
  creditCard: CreditCard,
  database: Database,
  fileText: FileText,
  kiosk: TabletSmartphone,
  key: KeyRound,
  languages: Languages,
  lifecycle: RefreshCcw,
  lock: Lock,
  mail: Mail,
  megaphone: Megaphone,
  message: MessageSquare,
  monitor: Monitor,
  plane: Plane,
  profileChange: FileText,
  qr: QrCode,
  receipt: Receipt,
  rupee: CreditCard,
  scroll: ScrollText,
  send: Send,
  shield: Shield,
  shieldCheck: ShieldCheck,
  sparkles: Sparkles,
  upload: Upload,
  userCircle: UserCircle,
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
