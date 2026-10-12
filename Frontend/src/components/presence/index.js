// Phase 37.2 — barrel for the presence self-service components.
// Imported by AppLayout (to mount PresenceMenu next to the avatar).

export { default as PresenceIndicator } from './PresenceIndicator.jsx';
export { default as PresenceMenu } from './PresenceMenu.jsx';
export { default as StatusExpirySelector } from './StatusExpirySelector.jsx';
export { default as StatusMessageEditor } from './StatusMessageEditor.jsx';
export { default as WorkLocationSelector } from './WorkLocationSelector.jsx';
export {
  describePresence,
  isSelectablePresence,
  presenceLabel,
  presencePalette,
} from './presenceVisual.js';