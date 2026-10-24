import { Link } from "react-router-dom";
import AuthArt from "../components/auth/AuthArt.jsx";

// ═══════════════════════════════════════════════════════════════════════════
// AuthLayout — the shared shell for Crewly's four authentication screens.
//
//   variant="split"    (default) — form on one side, hand-drawn scene on the other
//   variant="centered" — one narrow column, for reset / forgot-password
//
// The look is the public home page after dark: warm charcoal, cream type, one
// editorial serif for the display line, and clay for links. The scene on the
// right is inline SVG (no image request, no webfont) and is decorative.
//
// Two things this layout deliberately does NOT have:
//   · a testimonial. The old split panel carried a quoted customer with a name
//     and a job title, and no such customer exists in this repository.
//   · a "Continue with Google" button. The reference has one; there is no OAuth
//     provider behind this product, so the slot would be a button that cannot
//     work. The form is the only way in, and it says so.
//
// Presentation only: the pages keep every piece of their own logic.
// ═══════════════════════════════════════════════════════════════════════════

const Logo = () => (
  <Link
    to="/"
    aria-label="Crewly home"
    className="group inline-flex w-fit items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-crewly-lilac"
  >
    <img src="/logo-crewly-mark.png" alt="" className="h-7 w-7 object-contain" />
    <span className="auth-display text-[22px] leading-none text-crewly-void">Crewly</span>
  </Link>
);

// Legal pages do not exist in this product, so they are stated, not linked —
// the same rule the marketing footer follows.
const Footer = () => (
  <p className="text-[11px] leading-relaxed text-crewly-void/35">
    © {new Date().getFullYear()} Crewly · Terms and Privacy are not published yet — they will be
    linked here when they are.
  </p>
);

const Split = ({ visualSide, children }) => (
  <div className="auth-shell min-h-screen">
    <div className="mx-auto flex min-h-screen w-full max-w-[1480px] flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)]">
      <div
        className={`flex min-h-screen flex-col px-6 pb-6 pt-7 sm:px-10 lg:px-14 lg:pt-9 ${
          visualSide === "left" ? "lg:order-2" : ""
        }`}
      >
        <Logo />

        <main className="flex flex-1 items-center py-10 lg:py-12">
          <div className="mx-auto w-full max-w-[420px] lg:mx-0">{children}</div>
        </main>

        <Footer />
      </div>

      <div
        className={`relative hidden items-center justify-center border-crewly-void/10 px-6 lg:flex lg:border-l ${
          visualSide === "left" ? "lg:order-1" : ""
        }`}
        aria-hidden="true"
      >
        <div className="auth-float-slow w-full max-w-[600px]">
          <AuthArt />
        </div>
      </div>
    </div>
  </div>
);

const Centered = ({ children }) => (
  <div className="auth-wave-bg flex min-h-screen flex-col">
    <div className="px-6 pb-4 pt-7 sm:px-10">
      <Logo />
    </div>

    <div className="flex flex-1 items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">{children}</div>
    </div>

    <div className="px-6 pb-6 sm:px-10">
      <Footer />
    </div>
  </div>
);

const AuthLayout = ({ variant = "split", visualSide = "right", children }) =>
  variant === "centered" ? <Centered>{children}</Centered> : <Split visualSide={visualSide}>{children}</Split>;

export default AuthLayout;
