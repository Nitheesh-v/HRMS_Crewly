// Ticket kinds share the legacy SupportTicket collection. Historical rows
// predate the discriminator key and are intentionally treated as legacy.
export const SUPPORT_TICKET_KIND = Object.freeze({
  LEGACY: 'LEGACY_SUPPORT',
  HELPDESK: 'HELPDESK',
});

export const legacySupportTicketFilter = (filter = {}) => ({
  $and: [
    filter,
    {
      $or: [
        { ticketKind: SUPPORT_TICKET_KIND.LEGACY },
        { ticketKind: { $exists: false } },
        { ticketKind: null },
        { ticketKind: '' },
      ],
    },
  ],
});

export const isLegacySupportTicket = (ticket = {}) =>
  !ticket.ticketKind || ticket.ticketKind === SUPPORT_TICKET_KIND.LEGACY;
