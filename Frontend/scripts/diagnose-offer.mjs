// Throwaway diagnostic: render the public offer portal headlessly (jsdom)
// with the exact DTO the backend publicOffer endpoint returns, and capture
// any render-time crash via an error boundary.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/candidate/offer/TOKEN',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
const offerService = (await import('../src/services/offerService.js')).default;
const Layout = (await import('../src/layout/CandidateOfferPublicLayout.jsx')).default;
const Page = (await import('../src/pages/candidate/CandidateOfferPortalPage.jsx')).default;

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return React.createElement('div', { id: 'crash' }, `CRASH: ${this.state.error.message}`);
    }
    return this.props.children;
  }
}

const fullDto = {
  offerCode: 'OFF-000001',
  status: 'SENT',
  candidate: { name: 'Demo Candidate' },
  job: { title: 'Engineer' },
  company: { name: 'Demo Company' },
  terms: {
    designation: 'Engineer',
    departmentName: 'Eng',
    workMode: 'ONSITE',
    location: 'CBE',
    joiningDate: '2026-10-01T00:00:00.000Z',
    expiryDate: '2026-12-01T00:00:00.000Z',
    reportingManagerName: 'Boss',
  },
  compensation: {
    annualCTC: 1200000,
    currency: 'INR',
    monthly: { basic: 50000, hra: 20000, allowances: 10000 },
    variablePay: 100000,
    bonus: 50000,
  },
  renderedContent: 'Offer letter text',
  document: { fileName: 'offer.pdf' },
  viewedAt: null,
  acceptedAt: null,
  rejectedAt: null,
  expiredAt: null,
  withdrawnAt: null,
};

const scenarios = {
  'loading-only (publicRead never resolves)': () => new Promise(() => {}),
  'full DTO': () => Promise.resolve(structuredClone(fullDto)),
  'compensation=null': () => {
    const dto = structuredClone(fullDto);
    dto.compensation = null;
    return Promise.resolve(dto);
  },
  'company=undefined': () => {
    const dto = structuredClone(fullDto);
    delete dto.company;
    return Promise.resolve(dto);
  },
  'terms=undefined': () => {
    const dto = structuredClone(fullDto);
    delete dto.terms;
    return Promise.resolve(dto);
  },
  'candidate=undefined': () => {
    const dto = structuredClone(fullDto);
    delete dto.candidate;
    return Promise.resolve(dto);
  },
  'publicRead rejects 404': () => Promise.reject(Object.assign(new Error('Offer is unavailable'), { status: 404 })),
};

for (const [name, stub] of Object.entries(scenarios)) {
  offerService.publicRead = stub;
  offerService.publicView = () => Promise.resolve(structuredClone(fullDto));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    React.createElement(
      Boundary,
      null,
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/candidate/offer/TOKEN'] },
        React.createElement(
          Routes,
          null,
          React.createElement(
            Route,
            { path: '/candidate/offer', element: React.createElement(Layout) },
            React.createElement(Route, { path: ':secureToken', element: React.createElement(Page) })
          )
        )
      )
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  const crash = host.querySelector('#crash');
  const htmlLen = host.innerHTML.length;
  console.log(`SCENARIO [${name}] => ${crash ? crash.textContent : `no crash, rendered ${htmlLen} chars`}`);
  root.unmount();
  host.remove();
}
console.log('DIAGNOSTIC COMPLETE');
process.exit(0);
