// ── SMS CONVERSATIONS ──────────────────────────────────────────────────────────

let activeChatPhone = null;

async function renderReplies() {
  await loadDB();
  buildChatList();
  if (activeChatPhone) openChat(activeChatPhone, false);
  else showEmptyThread();
}

// Only include customers who have at least one inbound reply.
function buildConversations() {
  const convs = [];
  for (const c of db.customers) {
    if (!c.phone) continue;
    if (!c.smsReplies?.length) continue;
    const inbound  = (c.smsReplies || []).map(r => ({ dir: 'in',  text: r.message, date: r.receivedAt, label: r.birthdaySaved ? '🎂 Birthday saved' : '' }));
    const outbound = (c.smsSent   || []).map(m => ({ dir: 'out', text: m.message,  date: m.sentAt,     label: m.label || 'Sent' }));
    const messages = [...inbound, ...outbound].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!messages.length) continue;

    convs.push({
      customer:    c,
      messages,
      lastDate:    messages.at(-1)?.date || '',
      lastMessage: messages.at(-1),
    });
  }

  convs.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
  return convs;
}

function buildChatList() {
  const convs = buildConversations();
  const listEl = document.getElementById('chat-list');

  if (!convs.length) {
    listEl.innerHTML = '<div class="muted" style="padding:24px;text-align:center;font-size:.85rem">No replies yet.</div>';
    return;
  }

  listEl.innerHTML = convs.map(conv => {
    const c       = conv.customer;
    const name    = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone;
    const last    = conv.lastMessage;
    const preview = last ? (last.dir === 'out' ? '→ ' : '') + last.text : '';
    const dateStr = last ? fmtDate(last.date) : '';
    const active  = c.phone === activeChatPhone;
    return `<div data-phone="${c.phone}" onclick="openChat('${c.phone}')"
      style="padding:12px 16px;cursor:pointer;border-bottom:1px solid var(--border);
             background:${active ? 'var(--surface2)' : 'transparent'};transition:background .15s">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-weight:600;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px">${name}</span>
        <span class="muted" style="font-size:.7rem;flex-shrink:0;margin-left:6px">${dateStr}</span>
      </div>
      <div class="muted" style="font-size:.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview}</div>
    </div>`;
  }).join('');
}

function openChat(phone, scroll = true) {
  activeChatPhone = phone;

  // Highlight active item
  document.querySelectorAll('#chat-list > div[data-phone]').forEach(el => {
    el.style.background = el.dataset.phone === phone ? 'var(--surface2)' : 'transparent';
  });

  const conv = buildConversations().find(c => c.customer.phone === phone);
  if (!conv) return;

  const c    = conv.customer;
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || phone;

  document.getElementById('chat-header').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div>
        <div style="font-weight:600;font-size:.95rem">${name}</div>
        <div class="muted" style="font-size:.75rem">${phone}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="openCustModal('${c.id}')" style="margin-left:auto">View Profile</button>
    </div>`;

  const messagesEl = document.getElementById('chat-messages');
  if (!conv.messages.length) {
    messagesEl.innerHTML = '<div class="muted" style="text-align:center;padding:40px;font-size:.85rem">No messages yet.</div>';
    return;
  }

  messagesEl.innerHTML = conv.messages.map(m => {
    const isOut = m.dir === 'out';
    const time  = m.date ? new Date(m.date).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const meta  = [m.label, time].filter(Boolean).join(' · ');
    return `
      <div style="display:flex;flex-direction:column;align-items:${isOut ? 'flex-end' : 'flex-start'};margin-bottom:14px">
        <div style="max-width:65%;padding:10px 14px;
                    border-radius:${isOut ? '16px 16px 4px 16px' : '16px 16px 16px 4px'};
                    background:${isOut ? 'var(--accent)' : 'var(--surface)'};
                    border:1px solid var(--border);
                    color:${isOut ? '#fff' : 'inherit'};
                    font-size:.88rem;line-height:1.4">
          ${m.text}
        </div>
        <div class="muted" style="font-size:.7rem;margin-top:4px">${meta}</div>
      </div>`;
  }).join('');

  if (scroll) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showEmptyThread() {
  document.getElementById('chat-header').innerHTML = '';
  document.getElementById('chat-messages').innerHTML =
    '<div class="muted" style="text-align:center;padding:60px;font-size:.85rem">Select a conversation</div>';
}
