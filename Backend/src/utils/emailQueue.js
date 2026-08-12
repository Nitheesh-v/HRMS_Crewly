import * as mailerNS from './mailer.js';

// Probe the existing mailer (works in MOCK mode too) — falls back to console logging
const pickSender = () => {
  const candidates = [mailerNS.sendMail, mailerNS.sendEmail, mailerNS.send, mailerNS.default];
  for (const fn of candidates) if (typeof fn === 'function') return fn;
  return null;
};

const queue = [];
let started = false;

export const queueEmail = (job) => {
  if (!job?.to) return;
  queue.push({ ...job, attempts: 0 });
  startWorker();
};

const startWorker = () => {
  if (started || global.__crewlyEmailWorker) return;
  started = true;
  global.__crewlyEmailWorker = true;
  setInterval(drain, 5000); // 📮 drains every 5 seconds — APIs never wait
};

const drain = async () => {
  if (!queue.length) return;
  const job = queue.shift();
  try {
    const send = pickSender();
    if (send) {
      await send({ to: job.to, subject: job.subject, text: job.text, html: job.html });
    } else {
      console.log(`📧 [email queue] → ${job.to} — ${job.subject}${job.text ? ` — ${job.text}` : ''}`);
    }
  } catch (e) {
    if (job.attempts < 2) {
      job.attempts += 1;
      queue.push(job); // retry later
    }
  }
};