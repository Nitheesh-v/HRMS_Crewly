import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import axios from 'axios';
import App from './App.jsx';
import store from './redux/store.js';
import { attachFailureReporter } from './services/failureReporter.js';
import './style.css';

/*
 * 35.1 — the app-wide failure report, second attachment point.
 *
 * services/api.js covers the shared customer client. A handful of services
 * (attendance capture, BGV, offers, pre-onboarding, public careers, verifier
 * auth) keep their own `axios` usage, and their failures must read the same
 * way on screen. Attaching here, once, before the first render means every one
 * of them is covered without editing any of them.
 */
attachFailureReporter(axios);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Provider store={store}>
        <App />
      </Provider>
    </BrowserRouter>
  </React.StrictMode>
);
