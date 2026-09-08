import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5173/candidate/offer/TOKEN', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
const offerServiceMod = await import('../src/services/offerService.js');
console.log('default export keys:', Object.keys(offerServiceMod.default).filter(k=>k.startsWith('public')));
const Page = (await import('../src/pages/candidate/CandidateOfferPortalPage.jsx')).default;

offerServiceMod.default.publicRead = () => { console.log('STUB CALLED'); return Promise.resolve({ offerCode: 'X', status: 'SENT' }); };
offerServiceMod.default.publicView = () => Promise.resolve({});

class Boundary extends React.Component {
  constructor(p){super(p);this.state={error:null};}
  static getDerivedStateFromError(e){return {error:e};}
  render(){ return this.state.error ? React.createElement('div',{id:'crash'},'CRASH: '+this.state.error.message) : this.props.children; }
}

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
root.render(React.createElement(Boundary, null,
  React.createElement(MemoryRouter, { initialEntries: ['/candidate/offer/TOKEN'] },
    React.createElement(Routes, null,
      React.createElement(Route, { path: '/candidate/offer/:secureToken', element: React.createElement(Page) })))));
await new Promise((r) => setTimeout(r, 300));
console.log('RESULT:', host.querySelector('#crash') ? host.querySelector('#crash').textContent : 'no crash; html length ' + host.innerHTML.length);
process.exit(0);
