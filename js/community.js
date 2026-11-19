import { connectSupabase } from '../backend/supabase.js';

const $ = (selector) => document.querySelector(selector);
const statusBox = $('#backend-status');
const authPanel = $('#auth-panel');
const dashboard = $('#community-dashboard');
const chatShell = $('#chat-shell');
const authForm = $('#auth-form');
const authStatus = $('#auth-status');
const SUPPORTED_FILES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
let supabase;
let session;
let profile;
let activeConversation;
let activeOtherUser;
let realtimeChannel;
let searchTimer;
let typingTimer;
let messageSearchTerm = '';
let feedChannel;
let groupRealtimeChannel;
let groupDirectoryChannel;
let activeGroup;
let groupsState;
let isPortfolioOwner = false;
let initializationError;
let passwordResetInFlight = false;
let resolveSupabaseInitialization;
const supabaseInitialization = new Promise((resolve) => {
  resolveSupabaseInitialization = resolve;
});
const profileCache = new Map();

function showStatus(element, message, isError) {
  if (!element) return;
  element.textContent = message;
  element.className = 'form-status ' + (isError ? 'error' : 'success');
}

function makeAvatar(profileRow) {
  const avatar = document.createElement('span');
  avatar.className = 'user-avatar';
  avatar.textContent = (profileRow.display_name || profileRow.username || '?').slice(0, 1).toUpperCase();
  if (profileRow.avatar_path) {
    supabase.storage.from('community-avatars').createSignedUrl(profileRow.avatar_path, 3600)
      .then(({ data, error }) => {
        if (error || !data) return;
        const image = document.createElement('img');
        image.src = data.signedUrl;
        image.alt = '';
        avatar.textContent = '';
        avatar.appendChild(image);
      });
  }
  return avatar;
}

function setBackendMessage(message, isError) {
  $('#backend-status-title').textContent = isError ? 'Community needs attention' : 'Community connected';
  $('#backend-status-copy').textContent = message;
  statusBox.classList.toggle('error', Boolean(isError));
  statusBox.classList.toggle('ready', !isError);
}

function validateUpload(file, avatar) {
  const allowed = avatar
    ? new Set(['image/jpeg', 'image/png', 'image/webp'])
    : SUPPORTED_FILES;
  const limit = avatar ? 5 * 1024 * 1024 : MAX_FILE_SIZE;
  if (!file || !allowed.has(file.type) || file.size > limit) {
    throw new Error(avatar
      ? 'Choose a JPEG, PNG, or WebP image smaller than 5 MB.'
      : 'Choose a JPEG, PNG, WebP, PDF, or TXT file smaller than 10 MB.');
  }
}

async function loadProfile(userId) {
  const { data, error } = await supabase.from('profiles')
    .select('id, display_name, username, avatar_path, last_seen_at')
    .eq('id', userId).single();
  if (error) throw error;
  profile = data;
  profileCache.set(data.id, data);
  $('#profile-username').value = data.username;
  $('#profile-full-name').value = data.display_name;
  $('#dashboard-name').textContent = data.display_name;
  $('#dashboard-username').textContent = '@' + data.username;
  $('#dashboard-email').textContent = session.user.email || '';
  $('#dashboard-avatar').replaceChildren(document.createTextNode(
    (data.display_name || data.username).slice(0, 1).toUpperCase()
  ));
  const avatar = $('#my-avatar');
  avatar.replaceChildren(document.createTextNode(
    (data.display_name || data.username).slice(0, 1).toUpperCase()
  ));
  if (data.avatar_path) {
    const { data: signed, error: avatarError } = await supabase.storage
      .from('community-avatars').createSignedUrl(data.avatar_path, 3600);
    if (!avatarError && signed) {
      [avatar, $('#dashboard-avatar')].forEach((target) => {
        const image = document.createElement('img');
        image.src = signed.signedUrl;
        image.alt = '';
        target.replaceChildren(image);
      });
    }
  }
}

async function setSession(nextSession) {
  session = nextSession;
  isPortfolioOwner = false;
  $('#owner-admin-panel').hidden = true;
  $('#admin-tools').hidden = true;
  if (!session) {
    profile = null;
    groupsState = null;
    activeConversation = null;
    activeOtherUser = null;
    activeGroup = null;
    authPanel.hidden = false;
    dashboard.hidden = true;
    chatShell.hidden = true;
    $('#owner-admin-panel').hidden = true;
    $('#admin-tools').hidden = true;
    $('#group-chat-panel').hidden = true;
    $('#group-messages').replaceChildren();
    $('#community-feed').replaceChildren();
    if (realtimeChannel) {
      await supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    if (feedChannel) {
      await supabase.removeChannel(feedChannel);
      feedChannel = null;
    }
    if (groupRealtimeChannel) {
      await supabase.removeChannel(groupRealtimeChannel);
      groupRealtimeChannel = null;
    }
    if (groupDirectoryChannel) {
      await supabase.removeChannel(groupDirectoryChannel);
      groupDirectoryChannel = null;
    }
    return;
  }
  authPanel.hidden = true;
  dashboard.hidden = false;
  chatShell.hidden = false;
  try {
    await loadProfile(session.user.id);
    await loadOwnerAuthorization();
    await loadConversations();
    showStatus($('#feed-status'), 'Loading discussions…', false);
    await loadFeed();
    showStatus($('#feed-status'), 'Discussions loaded.', false);
    subscribeToFeed();
    showAdminControls();
    try {
      await loadGroups();
      subscribeToGroupDirectory();
    } catch (error) {
      showStatus($('#groups-status'), error.message || 'Could not load groups.', true);
    }
    await updateLastSeen();
  } catch (error) {
    showStatus($('#feed-status'), error.message || 'Could not load discussions.', true);
    setBackendMessage(error.message || 'Could not load the community. Check the Supabase schema and access policies.', true);
  }
}

async function loadOwnerAuthorization() {
  isPortfolioOwner = false;
  try {
    const { data, error } = await supabase.rpc('is_portfolio_owner');
    if (error) throw error;
    isPortfolioOwner = data === true;
  } catch (error) {
    showStatus($('#owner-groups-status'),
      'Owner verification is unavailable. Apply the reviewed owner UUID migration before enabling administration.',
      true);
    setBackendMessage('Owner verification failed: ' + (error.message || 'unknown error') +
      '. Owner-only controls are disabled until Supabase authorization is available.', true);
  }
}

function showAdminControls() {
  const panel = $('#admin-tools');
  const ownerPanel = $('#owner-admin-panel');
  panel.hidden = !isPortfolioOwner;
  ownerPanel.hidden = !isPortfolioOwner;
  if (isPortfolioOwner) {
    loadAdminUsers().catch((error) => setBackendMessage(error.message, true));
    loadReports().catch((error) => setBackendMessage(error.message, true));
    loadOwnerGroups().catch((error) => showStatus($('#owner-groups-status'), error.message, true));
  }
}

function attachAuthHandlers() {
  if (new URLSearchParams(window.location.search).get('password') === 'updated') {
    showStatus(authStatus, 'Your password has been updated. Sign in with your new password.', false);
  }
  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const isSignup = button.dataset.authMode === 'signup';
      authForm.dataset.mode = isSignup ? 'signup' : 'signin';
      authForm.setAttribute('aria-labelledby', isSignup ? 'signup-tab' : 'signin-tab');
      document.querySelectorAll('[data-auth-mode]').forEach((tab) => {
        const active = tab === button;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.signup-only').forEach((field) => {
        field.hidden = !isSignup;
        field.querySelectorAll('input').forEach((input) => {
          input.disabled = !isSignup;
          input.required = isSignup;
        });
      });
      $('#signin-assistance').hidden = isSignup;
      authForm.elements.password.autocomplete = isSignup ? 'new-password' : 'current-password';
      authForm.elements.password.minLength = isSignup ? 8 : 0;
      $('#auth-submit').textContent = isSignup ? 'Create account' : 'Sign in';
      authStatus.textContent = '';
    });
  });

  $('#password-recovery-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (passwordResetInFlight) return;
    const emailInput = $('#recovery-email');
    const email = emailInput.value.trim().toLowerCase();
    if (!email || !emailInput.validity.valid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStatus($('#recovery-status'), 'Enter a valid email address.', true);
      emailInput.focus();
      return;
    }
    const button = $('#send-reset-submit');
    passwordResetInFlight = true;
    button.disabled = true;
    button.textContent = 'Sending…';
    showStatus($('#recovery-status'), 'Sending reset request…', false);
    const redirectTo = `${window.location.origin}/reset-password`;
    try {
      const client = supabase || await supabaseInitialization;
      if (!client) throw initializationError || new Error('The Supabase client did not initialize.');
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      showStatus($('#recovery-status'),
        'If an account exists for that email, a reset link has been requested. Check your inbox and spam folder.', false);
    } catch (error) {
      console.error('Supabase password reset request failed:', error);
      const errorMessage = error && typeof error.message === 'string' ? error.message : '';
      const redirectRejected = (error && error.code === 'redirect_to_not_allowed') ||
        /redirect.{0,30}(not allowed|allowlist|allowed)/i.test(errorMessage);
      showStatus($('#recovery-status'), redirectRejected
        ? `Supabase rejected the recovery URL. Add ${redirectTo} to Authentication → URL Configuration → Redirect URLs.`
        : !supabase && initializationError
          ? `Supabase initialization failed: ${initializationError.message}`
          : 'Supabase could not process the reset request. Check the email provider, network connection, and Supabase Auth configuration, then try again.', true);
    } finally {
      passwordResetInFlight = false;
      button.disabled = false;
      button.textContent = 'Send Reset Link';
    }
  });
  $('#password-recovery-form').dataset.handlerReady = 'true';
  document.dispatchEvent(new Event('community:password-recovery-ready'));

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;
    const isSignup = authForm.dataset.mode === 'signup';
    const email = authForm.elements.email.value.trim().toLowerCase();
    const password = authForm.elements.password.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStatus(authStatus, 'Enter a valid email address.', true);
      return;
    }
    if (isSignup && password.length < 8) {
      showStatus(authStatus, 'Use a password with at least 8 characters.', true);
      return;
    }
    if (isSignup && password !== authForm.elements.confirmPassword.value) {
      showStatus(authStatus, 'The passwords do not match.', true);
      return;
    }
    if (!supabase) {
      showStatus(authStatus, initializationError && initializationError.message
        ? initializationError.message
        : 'Supabase is still initializing. Wait briefly, then try again.', true);
      return;
    }
    const button = $('#auth-submit');
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = isSignup ? 'Creating account…' : 'Signing in…';
    try {
      const result = isSignup
        ? await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: authForm.elements.fullName.value.trim() } }
        })
        : await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (isSignup && !result.data.session) {
        showStatus(authStatus, 'Account registration received. Check your email to confirm the account, then sign in.', false);
      } else {
        showStatus(authStatus, isSignup ? 'Account created. Welcome to the community.' : 'Signed in successfully.', false);
      }
    } catch (error) {
      showStatus(authStatus, error.message || 'Authentication failed. Please try again.', true);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  $('#signout-button').addEventListener('click', async () => {
    if (!supabase) return;
    try {
      const { error } = await supabase.auth.signOut();
      if (error) setBackendMessage(error.message, true);
    } catch (error) {
      setBackendMessage(error.message || 'Could not sign out. Please try again.', true);
    }
  });
}

function appendProfileButton(container, user) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'user-result';
  button.append(makeAvatar(user));
  const copy = document.createElement('span');
  copy.className = 'user-copy';
  const name = document.createElement('strong');
  name.textContent = user.display_name || user.username;
  const subtitle = document.createElement('small');
  subtitle.textContent = 'Community member';
  copy.append(name, subtitle);
  button.append(copy);
  button.addEventListener('click', () => openDirectConversation(user));
  container.append(button);
}

function handleUserSearch() {
  const input = $('#user-search');
  input.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      const list = $('#user-results');
      list.replaceChildren();
      const term = input.value.trim();
      if (!term || !session) return;
      const safeTerm = term.replace(/[%_,]/g, '');
      if (!safeTerm) {
        list.textContent = 'Enter a name or username.';
        return;
      }
      try {
        const [usernameResult, nameResult] = await Promise.all([
          supabase.from('profiles').select('id, display_name, username, avatar_path, last_seen_at')
            .ilike('username', '%' + safeTerm + '%').neq('id', session.user.id).limit(20),
          supabase.from('profiles').select('id, display_name, username, avatar_path, last_seen_at')
            .ilike('display_name', '%' + safeTerm + '%').neq('id', session.user.id).limit(20)
        ]);
        if (usernameResult.error || nameResult.error) {
          setBackendMessage((usernameResult.error || nameResult.error).message, true);
          return;
        }
        const data = Array.from(new Map(
          [...usernameResult.data, ...nameResult.data].map((user) => [user.id, user])
        ).values()).slice(0, 20);
        if (!data.length) list.textContent = 'No matching accounts.';
        data.forEach((user) => {
          profileCache.set(user.id, user);
          appendProfileButton(list, user);
        });
      } catch (error) {
        setBackendMessage(error.message || 'Could not search community profiles.', true);
      }
    }, 250);
  });
}

async function openDirectConversation(user) {
  const { data, error } = await supabase.rpc('start_direct_conversation', { other_user: user.id });
  if (error) {
    setBackendMessage(error.message, true);
    return;
  }
  activeOtherUser = user;
  await loadConversations();
  await openConversation(data, user);
}

async function loadConversations() {
  const list = $('#conversation-list');
  list.replaceChildren();
  const { data: memberships, error } = await supabase.from('conversation_members')
    .select('conversation_id').eq('user_id', session.user.id);
  if (error) throw error;
  if (!memberships.length) {
    list.textContent = 'No conversations yet.';
    return;
  }
  const conversationIds = memberships.map((row) => row.conversation_id);
  const { data: members, error: memberError } = await supabase.from('conversation_members')
    .select('conversation_id, user_id').in('conversation_id', conversationIds);
  if (memberError) throw memberError;
  const otherIds = Array.from(new Set(members.map((row) => row.user_id).filter((id) => id !== session.user.id)));
  const { data: people, error: peopleError } = await supabase.from('profiles')
    .select('id, display_name, username, avatar_path, last_seen_at').in('id', otherIds);
  if (peopleError) throw peopleError;
  const byId = new Map(people.map((person) => [person.id, person]));
  people.forEach((person) => profileCache.set(person.id, person));
  const { data: unreadMessages, error: unreadError } = await supabase.from('messages')
    .select('id, conversation_id').in('conversation_id', conversationIds)
    .neq('sender_id', session.user.id);
  if (unreadError) throw unreadError;
  const messageIds = unreadMessages.map((row) => row.id);
  let readSet = new Set();
  if (messageIds.length) {
    const { data: readRows, error: readError } = await supabase.from('message_reads')
      .select('message_id').eq('user_id', session.user.id).in('message_id', messageIds);
    if (readError) throw readError;
    readSet = new Set(readRows.map((row) => row.message_id));
  }
  memberships.forEach((membership) => {
    const participant = members.find((row) =>
      row.conversation_id === membership.conversation_id && row.user_id !== session.user.id);
    const person = participant && byId.get(participant.user_id);
    if (!person) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-button' + (membership.conversation_id === activeConversation ? ' active' : '');
    button.append(makeAvatar(person));
    const copy = document.createElement('span');
    copy.className = 'user-copy';
    const name = document.createElement('strong');
    name.textContent = person.display_name || person.username;
    const unreadCount = unreadMessages.filter((msg) => msg.conversation_id === membership.conversation_id && !readSet.has(msg.id)).length;
    const subtitle = document.createElement('small');
    subtitle.textContent = unreadCount ? unreadCount + ' unread message' + (unreadCount === 1 ? '' : 's') : 'Private conversation';
    copy.append(name, subtitle);
    button.append(copy);
    button.addEventListener('click', () => openConversation(membership.conversation_id, person));
    list.append(button);
  });
}

async function openConversation(conversationId, otherUser) {
  activeConversation = conversationId;
  activeOtherUser = otherUser;
  $('#chat-title').textContent = otherUser.display_name || otherUser.username;
  const lastSeen = otherUser.last_seen_at ? new Date(otherUser.last_seen_at) : null;
  const online = lastSeen && (Date.now() - lastSeen.getTime()) < 2 * 60 * 1000;
  const presenceText = online ? 'Online' : lastSeen ? 'Last seen ' + lastSeen.toLocaleString() : 'Offline / not recently seen';
  $('#chat-subtitle').textContent = 'Private one-to-one chat · ' + presenceText;
  $('#chat-presence').classList.toggle('online', Boolean(online));
  if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase.channel('community-' + conversationId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + conversationId }, () => {
      loadMessages().catch((error) => setBackendMessage(error.message, true));
      loadConversations().catch((error) => setBackendMessage(error.message, true));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_presence', filter: 'conversation_id=eq.' + conversationId }, () => {
      updateTypingIndicator().catch((error) => setBackendMessage(error.message, true));
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reads' }, () => {
      loadMessages().catch((error) => setBackendMessage(error.message, true));
    })
    .subscribe();
  await loadMessages();
  await loadConversations();
  enableMessageForm();
}

function enableMessageForm() {
  $('#message-text').disabled = false;
  $('#message-form button[type="submit"]').disabled = false;
}

async function loadMessages() {
  if (!activeConversation) return;
  const messages = $('#messages');
  const { data, error } = await supabase.from('messages').select('*')
    .eq('conversation_id', activeConversation).order('created_at', { ascending: true }).limit(200);
  if (error) throw error;
  let visible = data;
  if (messageSearchTerm) {
    visible = data.filter((message) => message.content.toLowerCase().includes(messageSearchTerm.toLowerCase()));
  }
  messages.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = messageSearchTerm ? 'No matching messages in this chat.' : 'No messages yet. Say hello.';
    messages.append(empty);
  }
  const relevantIds = visible.map((message) => message.id);
  const { data: reads, error: readsError } = relevantIds.length
    ? await supabase.from('message_reads').select('message_id, user_id').in('message_id', relevantIds)
    : { data: [], error: null };
  if (readsError) throw readsError;
  const readIds = new Set(reads.filter((row) => row.user_id === activeOtherUser.id).map((row) => row.message_id));
  for (const row of visible) {
    const bubble = document.createElement('article');
    bubble.className = 'message' + (row.sender_id === session.user.id ? ' own' : '');
    const sender = row.sender_id === session.user.id ? profile : activeOtherUser;
    const author = document.createElement('strong');
    author.className = 'message-author';
    author.textContent = sender.display_name || sender.username;
    bubble.append(author);
    if (row.content) {
      const content = document.createElement('p');
      content.className = 'message-body';
      content.textContent = row.content;
      bubble.append(content);
    }
    if (row.attachment_path) {
      const { data: signed, error: fileError } = await supabase.storage.from('community-files')
        .createSignedUrl(row.attachment_path, 300);
      if (!fileError && signed) {
        const link = document.createElement('a');
        link.className = 'message-file';
        link.href = signed.signedUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = row.attachment_name || 'View attachment';
        bubble.append(link);
        if (/\.(jpe?g|png|webp)$/i.test(row.attachment_name || '')) {
          const preview = document.createElement('img');
          preview.className = 'message-attachment';
          preview.src = signed.signedUrl;
          preview.alt = 'Shared image';
          bubble.append(preview);
        }
      }
    }
    const time = document.createElement('time');
    time.className = 'message-time';
    time.dateTime = row.created_at;
    time.textContent = new Date(row.created_at).toLocaleString();
    if (row.sender_id === session.user.id && readIds.has(row.id)) time.textContent += ' · Read';
    bubble.append(time);
    if (row.sender_id !== session.user.id) {
      const report = document.createElement('button');
      report.className = 'report-button';
      report.type = 'button';
      report.textContent = 'Report';
      report.addEventListener('click', () => reportMessage(row.id));
      bubble.append(report);
    }
    messages.append(bubble);
  }
  messages.scrollTop = messages.scrollHeight;
  const unread = visible.filter((row) => row.sender_id !== session.user.id)
    .map((row) => ({ message_id: row.id, user_id: session.user.id }));
  if (unread.length) {
    const { error: markError } = await supabase.from('message_reads')
      .upsert(unread, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
    if (markError) throw markError;
  }
}

async function reportMessage(messageId) {
  const reason = window.prompt('Briefly describe why you are reporting this message:');
  if (!reason) return;
  const { error } = await supabase.from('message_reports').insert({
    message_id: messageId,
    reporter_id: session.user.id,
    reason: reason.trim().slice(0, 500)
  });
  if (error) setBackendMessage(error.message, true);
  else window.alert('Report submitted to the portfolio owner.');
}

function attachMessageHandlers() {
  const form = $('#message-form');
  const textarea = $('#message-text');
  const clearTyping = async () => {
    window.clearTimeout(typingTimer);
    if (!activeConversation || !session) return;
    const { error } = await supabase.from('conversation_presence').upsert({
      conversation_id: activeConversation, user_id: session.user.id, typing_until: null
    }, { onConflict: 'conversation_id,user_id' });
    if (error) setBackendMessage(error.message, true);
  };
  textarea.addEventListener('input', () => {
    if (!activeConversation) return;
    window.clearTimeout(typingTimer);
    supabase.from('conversation_presence').upsert({
      conversation_id: activeConversation,
      user_id: session.user.id,
      typing_until: new Date(Date.now() + 4000).toISOString()
    }, { onConflict: 'conversation_id,user_id' }).then(({ error }) => {
      if (error) setBackendMessage(error.message, true);
    });
    typingTimer = window.setTimeout(clearTyping, 2500);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeConversation || !form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    let uploadedPath = null;
    try {
      const file = $('#message-file').files[0];
      if (file) {
        validateUpload(file, false);
        const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
        uploadedPath = activeConversation + '/' + session.user.id + '/' + crypto.randomUUID() + '-' + safeName;
        const { error: uploadError } = await supabase.storage.from('community-files')
          .upload(uploadedPath, file, { contentType: file.type, upsert: false });
        if (uploadError) throw uploadError;
      }
      const content = textarea.value.trim();
      if (!content && !uploadedPath) throw new Error('Write a message or choose a file.');
      const { error } = await supabase.from('messages').insert({
        conversation_id: activeConversation,
        sender_id: session.user.id,
        content,
        attachment_path: uploadedPath,
        attachment_name: $('#message-file').files[0] ? $('#message-file').files[0].name : null
      });
      if (error) throw error;
      textarea.value = '';
      $('#message-file').value = '';
      await clearTyping();
      await loadMessages();
      await loadConversations();
    } catch (error) {
      setBackendMessage(error.message || 'The message could not be sent.', true);
    } finally {
      button.disabled = false;
    }
  });
  $('#message-file').addEventListener('change', () => {
    const file = $('#message-file').files[0];
    if (!file) return;
    try { validateUpload(file, false); }
    catch (error) {
      $('#message-file').value = '';
      setBackendMessage(error.message, true);
      return;
    }
    setBackendMessage('Ready to attach: ' + file.name, false);
  });
  $('#message-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    messageSearchTerm = $('#message-search').value.trim();
    loadMessages().catch((error) => setBackendMessage(error.message, true));
  });
  $('#message-search').addEventListener('search', () => {
    if (!$('#message-search').value) {
      messageSearchTerm = '';
      loadMessages().catch((error) => setBackendMessage(error.message, true));
    }
  });
}

async function saveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const status = form.querySelector('[role="status"]');
  try {
    const displayName = form.elements.fullName.value.trim();
    const username = form.elements.username.value.trim();
    if (displayName.length < 2 || displayName.length > 80) {
      throw new Error('Your full name must be between 2 and 80 characters.');
    }
    const file = form.elements.avatar.files[0];
    let avatarPath = profile.avatar_path;
    if (file) {
      validateUpload(file, true);
      avatarPath = session.user.id + '/' + crypto.randomUUID() + '-' + file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-90);
      const { error: uploadError } = await supabase.storage.from('community-avatars')
        .upload(avatarPath, file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
    }
    const { data, error } = await supabase.from('profiles').update({
      display_name: displayName, username, avatar_path: avatarPath, last_seen_at: new Date().toISOString()
    }).eq('id', session.user.id).select('id, display_name, username, avatar_path, last_seen_at').single();
    if (error) throw error;
    profile = data;
    profileCache.set(data.id, data);
    await loadProfile(data.id);
    showStatus(status, 'Profile updated.', false);
  } catch (error) {
    showStatus(status, error.message || 'Profile update failed.', true);
  }
}

async function updateLastSeen() {
  const { error } = await supabase.from('profiles')
    .update({ last_seen_at: new Date().toISOString() }).eq('id', session.user.id);
  if (error) setBackendMessage(error.message, true);
}

async function updateTypingIndicator() {
  if (!activeConversation) return;
  const { data, error } = await supabase.from('conversation_presence')
    .select('user_id, typing_until').eq('conversation_id', activeConversation)
    .neq('user_id', session.user.id).gt('typing_until', new Date().toISOString());
  if (error) throw error;
  $('#typing-indicator').textContent = data.length
    ? (activeOtherUser.display_name || activeOtherUser.username) + ' is typing…'
    : '';
}

async function loadAdminUsers() {
  const input = $('#admin-user-search');
  const output = $('#admin-users');
  const render = async () => {
    const term = input.value.trim();
    let query = supabase.from('profiles').select('id, display_name, username, last_seen_at').order('username').limit(100);
    if (term) query = query.ilike('username', '%' + term.replace(/[%_,]/g, '') + '%');
    const [{ data: users, error }, { data: blocked, error: blockError }] = await Promise.all([
      query,
      supabase.from('user_blocks').select('blocked_user')
    ]);
    if (error) throw error;
    if (blockError) throw blockError;
    const blockedIds = new Set(blocked.map((row) => row.blocked_user));
    output.replaceChildren();
    users.filter((user) => user.id !== session.user.id).forEach((user) => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const label = document.createElement('span');
      label.textContent = user.display_name || user.username;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary small';
      button.textContent = blockedIds.has(user.id) ? 'Unblock' : 'Block';
      button.addEventListener('click', async () => {
        const { error: actionError } = await supabase.rpc(
          blockedIds.has(user.id) ? 'admin_unblock_community_user' : 'admin_block_community_user',
          { target_user: user.id }
        );
        if (actionError) setBackendMessage(actionError.message, true);
        else render().catch((loadError) => setBackendMessage(loadError.message, true));
      });
      row.append(label, button);
      output.append(row);
    });
  };
  input.addEventListener('input', () => render().catch((error) => setBackendMessage(error.message, true)));
  await render();
}

async function loadReports() {
  const output = $('#admin-reports');
  const { data, error } = await supabase.from('message_reports')
    .select('id, reason, status, created_at, reporter_id, message:messages!message_reports_message_id_fkey(id, content, sender_id)')
    .eq('status', 'open').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  output.replaceChildren();
  if (!data.length) {
    output.textContent = 'No open reports.';
    return;
  }
  data.forEach((report) => {
    const row = document.createElement('div');
    row.className = 'admin-report';
    const description = document.createElement('p');
    description.textContent = '“' + (report.message.content || '[attachment]').slice(0, 180) + '” — ' + report.reason;
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    ['reviewed', 'dismissed'].forEach((status) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary small';
      button.textContent = status;
      button.addEventListener('click', async () => {
        const { error: updateError } = await supabase.from('message_reports').update({ status }).eq('id', report.id);
        if (updateError) setBackendMessage(updateError.message, true);
        else loadReports().catch((loadError) => setBackendMessage(loadError.message, true));
      });
      actions.append(button);
    });
    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'button secondary small';
    block.textContent = 'Block sender';
    block.addEventListener('click', async () => {
      const { error: blockError } = await supabase.rpc('admin_block_community_user', { target_user: report.message.sender_id });
      if (blockError) setBackendMessage(blockError.message, true);
      else setBackendMessage('Sender blocked by the backend.', false);
    });
    actions.append(block);
    row.append(description, actions);
    output.append(row);
  });
}

function formatCommunityDate(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function createCommunityButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

async function fetchAllFeedRows(buildQuery) {
  const pageSize = 500;
  const rows = [];
  let offset = 0;
  let total = null;
  while (total === null || offset < total) {
    const { data, error, count } = await buildQuery()
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (total === null && typeof count === 'number') total = count;
    if (!data.length) break;
    rows.push(...data);
    offset += data.length;
    if (total === null && data.length < pageSize) break;
  }
  return rows;
}

async function reloadFeedAfterAction(successMessage) {
  try {
    await loadFeed();
    showStatus($('#feed-status'), successMessage, false);
  } catch (error) {
    showStatus($('#feed-status'), successMessage + ' The feed could not refresh: ' +
      (error.message || 'Unknown error.'), true);
  }
}

async function loadFeed() {
  if (!session) return;
  const feed = $('#community-feed');
  const { data: posts, error: postError } = await supabase.from('community_posts')
    .select('id, author_id, content, created_at, updated_at')
    .order('created_at', { ascending: false }).limit(50);
  if (postError) throw postError;
  if (!posts.length) {
    feed.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No discussions yet. Start the first one.';
    feed.append(empty);
    return;
  }
  const postIds = posts.map((post) => post.id);
  const [comments, likes] = await Promise.all([
    fetchAllFeedRows(() => supabase.from('community_comments')
      .select('id, post_id, author_id, content, created_at', { count: 'exact' })
      .in('post_id', postIds).order('created_at', { ascending: true })),
    fetchAllFeedRows(() => supabase.from('community_post_likes')
      .select('post_id, user_id', { count: 'exact' }).in('post_id', postIds))
  ]);
  const authorIds = Array.from(new Set([
    ...posts.map((post) => post.author_id),
    ...comments.map((comment) => comment.author_id)
  ]));
  const { data: authors, error: authorError } = await supabase.from('profiles')
    .select('id, display_name, username').in('id', authorIds);
  if (authorError) throw authorError;
  const authorById = new Map(authors.map((author) => [author.id, author]));
  const commentsByPost = new Map();
  comments.forEach((comment) => {
    const rows = commentsByPost.get(comment.post_id) || [];
    rows.push(comment);
    commentsByPost.set(comment.post_id, rows);
  });
  const likesByPost = new Map();
  likes.forEach((like) => {
    const rows = likesByPost.get(like.post_id) || [];
    rows.push(like);
    likesByPost.set(like.post_id, rows);
  });
  feed.replaceChildren();
  posts.forEach((post) => {
    const article = document.createElement('article');
    article.className = 'community-post';
    const heading = document.createElement('header');
    heading.className = 'post-heading';
    const authorWrap = document.createElement('div');
    authorWrap.className = 'post-author';
    const author = authorById.get(post.author_id);
    const authorName = document.createElement('strong');
    authorName.textContent = author ? (author.display_name || author.username) : 'Community member';
    const time = document.createElement('time');
    time.dateTime = post.created_at;
    time.textContent = formatCommunityDate(post.created_at);
    const authorTag = document.createElement('small');
    authorTag.textContent = author && author.username ? '@' + author.username : '';
    authorWrap.append(authorName, authorTag, time);
    heading.append(authorWrap);
    if (post.author_id === session.user.id || isPortfolioOwner) {
      const ownerActions = document.createElement('div');
      ownerActions.className = 'post-owner-actions';
      const deletePostButton = createCommunityButton('Delete', 'button secondary small', async () => {
        if (!window.confirm('Delete this discussion and its comments?')) return;
        const label = deletePostButton.textContent;
        deletePostButton.disabled = true;
        deletePostButton.textContent = 'Deleting…';
        showStatus($('#feed-status'), 'Deleting the discussion…', false);
        try {
          let query = supabase.from('community_posts').delete().eq('id', post.id);
          if (!isPortfolioOwner) query = query.eq('author_id', session.user.id);
          const { data, error } = await query.select('id');
          if (error) throw error;
          if (!data || !data.length) throw new Error('The discussion was not deleted. Check your permissions.');
          article.remove();
          await reloadFeedAfterAction('Discussion and its associated comments/likes deleted.');
        } catch (error) {
          showStatus($('#feed-status'), error.message || 'Could not delete the post.', true);
        } finally {
          if (deletePostButton.isConnected) {
            deletePostButton.disabled = false;
            deletePostButton.textContent = label;
          }
        }
      });
      if (post.author_id === session.user.id) {
        ownerActions.append(createCommunityButton('Edit', 'button secondary small', () => togglePostEditor(article, post)));
      }
      ownerActions.append(deletePostButton);
      heading.append(ownerActions);
    }
    const content = document.createElement('p');
    content.className = 'post-content';
    content.textContent = post.content;
    article.append(heading, content);

    const postLikes = likesByPost.get(post.id) || [];
    const actions = document.createElement('div');
    actions.className = 'post-actions';
    const likedByMe = postLikes.some((like) => like.user_id === session.user.id);
    const likeButton = createCommunityButton(
      (likedByMe ? 'Unlike' : 'Like') + ' · ' + postLikes.length,
      'button secondary small like-button',
      async () => {
        const wasLiked = likeButton.getAttribute('aria-pressed') === 'true';
        const previousLabel = likeButton.textContent;
        const nextCount = postLikes.length + (wasLiked ? -1 : 1);
        likeButton.setAttribute('aria-pressed', String(!wasLiked));
        likeButton.textContent = (wasLiked ? 'Like' : 'Unlike') + ' · ' + Math.max(0, nextCount);
        likeButton.disabled = true;
        showStatus($('#feed-status'), wasLiked ? 'Removing your like…' : 'Saving your like…', false);
        let saved = false;
        try {
          const result = wasLiked
            ? await supabase.from('community_post_likes').delete()
              .eq('post_id', post.id).eq('user_id', session.user.id)
            : await supabase.from('community_post_likes').insert({ post_id: post.id, user_id: session.user.id });
          if (result.error) throw result.error;
          saved = true;
          await reloadFeedAfterAction(wasLiked ? 'Like removed.' : 'Post liked.');
        } catch (error) {
          if (!saved) {
            likeButton.setAttribute('aria-pressed', String(wasLiked));
            likeButton.textContent = previousLabel;
            try {
              await loadFeed();
            } catch (refreshError) {
              showStatus($('#feed-status'), (error.message || 'Could not update your like.') +
                ' Feed refresh also failed: ' + (refreshError.message || 'Unknown error.'), true);
              return;
            }
          }
          showStatus($('#feed-status'), error.message || 'Could not update your like.', true);
        } finally {
          if (likeButton.isConnected) likeButton.disabled = false;
        }
      }
    );
    likeButton.setAttribute('aria-pressed', String(likedByMe));
    actions.append(likeButton);
    article.append(actions);

    const commentList = document.createElement('div');
    commentList.className = 'post-comments';
    (commentsByPost.get(post.id) || []).forEach((comment) => {
      const row = document.createElement('article');
      row.className = 'post-comment';
      const commentAuthor = authorById.get(comment.author_id);
      const name = document.createElement('strong');
      name.textContent = commentAuthor ? (commentAuthor.display_name || commentAuthor.username) : 'Community member';
      const username = document.createElement('small');
      username.className = 'comment-username';
      username.textContent = commentAuthor && commentAuthor.username ? '@' + commentAuthor.username : '';
      const commentTime = document.createElement('time');
      commentTime.dateTime = comment.created_at;
      commentTime.textContent = formatCommunityDate(comment.created_at);
      const text = document.createElement('p');
      text.textContent = comment.content;
      row.append(name, username, commentTime, text);
      if (comment.author_id === session.user.id || isPortfolioOwner) {
        const deleteCommentButton = createCommunityButton('Delete', 'button secondary small', async () => {
          if (!window.confirm('Delete this comment?')) return;
          deleteCommentButton.disabled = true;
          deleteCommentButton.textContent = 'Deleting…';
          showStatus($('#feed-status'), 'Deleting the comment…', false);
          try {
            let query = supabase.from('community_comments').delete().eq('id', comment.id);
            if (!isPortfolioOwner) query = query.eq('author_id', session.user.id);
            const { data, error } = await query.select('id');
            if (error) throw error;
            if (!data || !data.length) throw new Error('The comment was not deleted. Check your permissions.');
            await reloadFeedAfterAction('Comment deleted.');
          } catch (error) {
            showStatus($('#feed-status'), error.message || 'Could not delete the comment.', true);
          } finally {
            if (deleteCommentButton.isConnected) {
              deleteCommentButton.disabled = false;
              deleteCommentButton.textContent = 'Delete';
            }
          }
        });
        row.append(deleteCommentButton);
      }
      commentList.append(row);
    });
    const commentForm = document.createElement('form');
    commentForm.className = 'comment-form';
    const commentInput = document.createElement('textarea');
    commentInput.rows = 1;
    commentInput.maxLength = 800;
    commentInput.required = true;
    commentInput.setAttribute('aria-label', 'Write a comment');
    commentInput.placeholder = 'Add a comment…';
    const commentSubmit = document.createElement('button');
    commentSubmit.type = 'submit';
    commentSubmit.className = 'button secondary small';
    commentSubmit.textContent = 'Comment';
    commentForm.append(commentInput, commentSubmit);
    commentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const commentContent = commentInput.value.trim();
      if (!commentContent) {
        showStatus($('#feed-status'), 'Write a comment before submitting.', true);
        commentInput.focus();
        return;
      }
      if (commentContent.length > 800) {
        showStatus($('#feed-status'), 'Comments must be 800 characters or fewer.', true);
        return;
      }
      commentSubmit.disabled = true;
      commentSubmit.textContent = 'Posting…';
      showStatus($('#feed-status'), 'Posting your comment…', false);
      try {
        const { error } = await supabase.from('community_comments').insert({
          post_id: post.id, author_id: session.user.id, content: commentContent
        });
        if (error) throw error;
        await reloadFeedAfterAction('Comment posted.');
      } catch (error) {
        showStatus($('#feed-status'), error.message || 'Could not post the comment.', true);
      } finally {
        if (commentSubmit.isConnected) {
          commentSubmit.disabled = false;
          commentSubmit.textContent = 'Comment';
        }
      }
    });
    article.append(commentList, commentForm);
    feed.append(article);
  });
}

function togglePostEditor(article, post) {
  const existing = article.querySelector('.post-edit-form');
  if (existing) {
    existing.remove();
    return;
  }
  const form = document.createElement('form');
  form.className = 'post-edit-form';
  const textarea = document.createElement('textarea');
  textarea.value = post.content;
  textarea.maxLength = 2800;
  textarea.required = true;
  textarea.setAttribute('aria-label', 'Edit discussion text');
  const actions = document.createElement('div');
  actions.className = 'post-edit-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button small';
  save.textContent = 'Save changes';
  const cancel = createCommunityButton('Cancel', 'button secondary small', () => form.remove());
  actions.append(save, cancel);
  form.append(textarea, actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = textarea.value.trim();
    if (!content) {
      showStatus($('#feed-status'), 'Post content cannot be empty.', true);
      textarea.focus();
      return;
    }
    if (content.length > 2800) {
      showStatus($('#feed-status'), 'Posts must be 2,800 characters or fewer.', true);
      return;
    }
    save.disabled = true;
    save.textContent = 'Saving…';
    showStatus($('#feed-status'), 'Saving your post…', false);
    try {
      const { error } = await supabase.from('community_posts').update({ content })
        .eq('id', post.id).eq('author_id', session.user.id);
      if (error) throw error;
      article.querySelector('.post-content').textContent = content;
      post.content = content;
      form.remove();
      await reloadFeedAfterAction('Post updated.');
    } catch (error) {
      showStatus($('#feed-status'), error.message || 'Could not save your post.', true);
    } finally {
      if (save.isConnected) {
        save.disabled = false;
        save.textContent = 'Save changes';
      }
    }
  });
  article.insertBefore(form, article.querySelector('.post-actions'));
  textarea.focus();
}

function subscribeToFeed() {
  if (feedChannel) supabase.removeChannel(feedChannel);
  feedChannel = supabase.channel('community-discussions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'community_posts' }, () => {
      loadFeed().catch((error) => showStatus($('#feed-status'), error.message, true));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'community_comments' }, () => {
      loadFeed().catch((error) => showStatus($('#feed-status'), error.message, true));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'community_post_likes' }, () => {
      loadFeed().catch((error) => showStatus($('#feed-status'), error.message, true));
    })
    .subscribe();
}

function attachCommunityHandlers() {
  $('#profile-form').addEventListener('submit', saveProfile);
  $('#feed-refresh').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    showStatus($('#feed-status'), 'Refreshing discussions…', false);
    try {
      await loadFeed();
      showStatus($('#feed-status'), 'Discussions refreshed.', false);
    } catch (error) {
      showStatus($('#feed-status'), error.message || 'Could not refresh discussions.', true);
    } finally {
      button.disabled = false;
      button.textContent = 'Refresh';
    }
  });
  $('#post-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const content = form.elements.content.value.trim();
    if (!content || content.length > 2800) {
      showStatus($('#post-status'), 'Write between 1 and 2,800 characters.', true);
      return;
    }
    const button = $('#post-submit');
    button.disabled = true;
    button.textContent = 'Sharing…';
    try {
      const { error } = await supabase.from('community_posts').insert({
        author_id: session.user.id, content
      });
      if (error) throw error;
      form.reset();
      showStatus($('#post-status'), 'Your discussion has been shared.', false);
      await reloadFeedAfterAction('Discussion shared.');
    } catch (error) {
      showStatus($('#post-status'), error.message || 'Could not share the discussion.', true);
    } finally {
      button.disabled = false;
      button.textContent = 'Share post';
    }
  });
}

function getGroupProfile(userId) {
  return profileCache.get(userId) || { id: userId, display_name: 'Student', username: 'student' };
}

async function loadGroupProfiles(userIds) {
  const missingIds = [...new Set(userIds)].filter((id) => id && !profileCache.has(id));
  if (!missingIds.length) return;
  const { data, error } = await supabase.from('profiles')
    .select('id, display_name, username, avatar_path')
    .in('id', missingIds);
  if (error) throw error;
  data.forEach((user) => profileCache.set(user.id, user));
}

async function loadGroups() {
  showStatus($('#groups-status'), 'Loading groups…', false);
  const groups = await fetchAllFeedRows(() => supabase.from('community_groups')
    .select('id, owner_id, name, description, visibility, avatar_path, created_at, updated_at')
    .order('created_at', { ascending: false }));
  const groupIds = groups.map((group) => group.id);
  let memberships = [];
  let requests = [];
  let countRows = [];
  if (groupIds.length) {
    const [membershipResult, requestResult, countResult] = await Promise.all([
      supabase.from('community_group_members')
        .select('group_id, user_id, role, joined_at').in('group_id', groupIds),
      supabase.from('community_group_join_requests')
        .select('id, group_id, user_id, status, created_at')
        .eq('status', 'pending').in('group_id', groupIds),
      supabase.rpc('community_group_member_counts', { target_group_ids: groupIds })
    ]);
    if (membershipResult.error) throw membershipResult.error;
    if (requestResult.error) throw requestResult.error;
    if (countResult.error) throw countResult.error;
    memberships = membershipResult.data || [];
    requests = requestResult.data || [];
    countRows = countResult.data || [];
  }
  await loadGroupProfiles([
    ...groups.map((group) => group.owner_id),
    ...memberships.map((member) => member.user_id),
    ...requests.map((request) => request.user_id)
  ]);
  groupsState = {
    groups,
    memberships,
    requests,
    counts: new Map(countRows.map((row) => [row.group_id, Number(row.member_count)]))
  };
  if (activeGroup && !memberships.some((member) =>
    member.group_id === activeGroup.id && member.user_id === session.user.id)) {
    closeGroupChatFor(activeGroup.id);
    showStatus($('#group-chat-status'), 'Your group membership ended, so this chat is no longer available.', true);
  }
  renderGroups();
  showStatus($('#groups-status'), groups.length ? 'Groups are up to date.' : 'No groups yet. Create one to get started.', false);
}

function renderGroups() {
  const output = $('#community-groups');
  output.replaceChildren();
  if (!groupsState) {
    output.textContent = 'Groups are not loaded.';
    return;
  }
  const term = $('#group-search').value.trim().toLocaleLowerCase();
  const groups = groupsState.groups.filter((group) => !term || group.name.toLocaleLowerCase().includes(term));
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = term ? 'No groups match that search.' : 'No groups are available yet.';
    output.append(empty);
    return;
  }
  groups.forEach((group) => output.append(renderGroupCard(group)));
}

function renderGroupCard(group) {
  const card = document.createElement('article');
  card.className = 'group-card';
  const header = document.createElement('header');
  header.className = 'group-card-header';
  const avatar = document.createElement('span');
  avatar.className = 'group-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = group.name.slice(0, 1).toUpperCase();
  if (group.avatar_path) {
    supabase.storage.from('community-avatars').createSignedUrl(group.avatar_path, 3600)
      .then(({ data, error }) => {
        if (error || !data || !avatar.isConnected) return;
        const image = document.createElement('img');
        image.src = data.signedUrl;
        image.alt = '';
        avatar.replaceChildren(image);
      });
  }
  const title = document.createElement('div');
  title.className = 'group-card-title';
  const name = document.createElement('h3');
  name.textContent = group.name;
  const visibility = document.createElement('span');
  visibility.className = 'group-visibility';
  visibility.textContent = group.visibility === 'private' ? 'Private' : 'Public';
  title.append(name, visibility);
  header.append(avatar, title);

  const description = document.createElement('p');
  description.className = 'group-card-description';
  description.textContent = group.description || 'No description provided.';
  const metadata = document.createElement('div');
  metadata.className = 'group-card-meta';
  const count = document.createElement('span');
  count.textContent = (groupsState.counts.get(group.id) || 0) + ' members';
  const creator = document.createElement('span');
  creator.textContent = 'Created by ' + (getGroupProfile(group.owner_id).display_name || getGroupProfile(group.owner_id).username);
  metadata.append(count, creator);
  card.append(header, description, metadata);

  const ownMembership = groupsState.memberships.find((member) =>
    member.group_id === group.id && member.user_id === session.user.id);
  const ownRequest = groupsState.requests.find((request) =>
    request.group_id === group.id && request.user_id === session.user.id);
  const isOwner = group.owner_id === session.user.id;
  const canManage = isPortfolioOwner || isOwner;
  const actions = document.createElement('div');
  actions.className = 'group-card-actions';
  if (ownMembership) {
    actions.append(createCommunityButton('Open group chat', 'button small', () => openGroupChat(group)));
    if (!isOwner) {
      actions.append(createCommunityButton('Leave group', 'button secondary small', async (event) => {
        const button = event.currentTarget;
        await runGroupAction(button, async () => {
          const { error } = await supabase.from('community_group_members')
            .delete().eq('group_id', group.id).eq('user_id', session.user.id);
          if (error) throw error;
          closeGroupChatFor(group.id);
        }, 'You left the group.');
      }));
    }
  } else if (group.visibility === 'public') {
    actions.append(createCommunityButton('Join group', 'button small', async (event) => {
      const button = event.currentTarget;
      await runGroupAction(button, async () => {
        const { error } = await supabase.from('community_group_members').insert({
          group_id: group.id, user_id: session.user.id, role: 'member'
        });
        if (error) throw error;
      }, 'You joined the group.');
    }));
  } else if (ownRequest) {
    const pending = document.createElement('button');
    pending.type = 'button';
    pending.className = 'button secondary small';
    pending.disabled = true;
    pending.textContent = 'Request pending';
    actions.append(pending);
  } else {
    actions.append(createCommunityButton('Request to join', 'button small', async (event) => {
      const button = event.currentTarget;
      await runGroupAction(button, async () => {
        const { error } = await supabase.rpc('request_community_group_join', { target_group: group.id });
        if (error) throw error;
      }, 'Your request was sent to the group owner.');
    }));
  }
  if (isOwner) {
    actions.append(createCommunityButton('Delete group', 'button danger small', async (event) => {
      if (!window.confirm('Delete this group and all its membership requests and chat messages? This cannot be undone.')) return;
      const button = event.currentTarget;
      await runGroupAction(button, async () => {
        const { data, error } = await supabase.from('community_groups').delete()
          .eq('id', group.id).eq('owner_id', session.user.id).select('id');
        if (error) throw error;
        if (!data || !data.length) throw new Error('The group was not deleted. Confirm that you still own it.');
        closeGroupChatFor(group.id);
        if (group.avatar_path) {
          const { error: imageError } = await supabase.storage.from('community-avatars').remove([group.avatar_path]);
          if (imageError) return 'Group deleted, but its image could not be removed: ' + imageError.message;
        }
      }, 'Group deleted.');
    }));
  }
  card.append(actions);
  if (canManage) {
    card.append(renderGroupManagement(group));
  }
  return card;
}

function renderGroupManagement(group) {
  const details = document.createElement('details');
  details.className = 'group-management';
  const summary = document.createElement('summary');
  summary.textContent = 'Manage group';
  const body = document.createElement('div');
  body.className = 'group-management-body';
  const editSection = document.createElement('section');
  editSection.className = 'group-management-section';
  const editHeading = document.createElement('h4');
  editHeading.textContent = 'Group details';
  const editForm = document.createElement('form');
  editForm.className = 'group-edit-form';
  const nameField = document.createElement('div');
  nameField.className = 'field';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Group name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.minLength = 2;
  nameInput.maxLength = 80;
  nameInput.required = true;
  nameInput.value = group.name;
  nameLabel.append(nameInput);
  nameField.append(nameLabel);
  const descriptionField = document.createElement('div');
  descriptionField.className = 'field';
  const descriptionLabel = document.createElement('label');
  descriptionLabel.textContent = 'Description';
  const descriptionInput = document.createElement('textarea');
  descriptionInput.maxLength = 1600;
  descriptionInput.value = group.description || '';
  descriptionLabel.append(descriptionInput);
  descriptionField.append(descriptionLabel);
  const editActions = document.createElement('div');
  editActions.className = 'group-management-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button small';
  save.textContent = 'Save details';
  const cancel = document.createElement('button');
  cancel.type = 'reset';
  cancel.className = 'button secondary small';
  cancel.textContent = 'Cancel';
  editActions.append(save, cancel);
  editForm.append(nameField, descriptionField, editActions);
  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const update = { name: nameInput.value.trim(), description: descriptionInput.value.trim() };
    if (update.name.length < 2) {
      nameInput.focus();
      return;
    }
    save.disabled = true;
    try {
      let query = supabase.from('community_groups').update(update).eq('id', group.id);
      if (!isPortfolioOwner) query = query.eq('owner_id', session.user.id);
      const { data, error } = await query.select('id');
      if (error) throw error;
      if (!data || !data.length) throw new Error('The group was not updated. Check your group permissions.');
      await loadGroups();
      if (isPortfolioOwner) await loadOwnerGroups();
      showStatus($('#groups-status'), 'Group details updated.', false);
    } catch (error) {
      showStatus($('#groups-status'), error.message || 'Could not update this group.', true);
    } finally {
      save.disabled = false;
    }
  });
  editSection.append(editHeading, editForm);
  body.append(editSection);

  const members = groupsState.memberships.filter((member) => member.group_id === group.id);
  const memberSection = document.createElement('section');
  memberSection.className = 'group-management-section';
  const memberHeading = document.createElement('h4');
  memberHeading.textContent = 'Members (' + members.length + ')';
  memberSection.append(memberHeading);
  members.forEach((member) => {
    const row = document.createElement('div');
    row.className = 'group-person-row';
    const label = document.createElement('span');
    label.className = 'group-person-name';
    const memberProfile = getGroupProfile(member.user_id);
    label.textContent = (memberProfile.display_name || memberProfile.username) +
      (member.role === 'owner' ? ' · owner' : '');
    row.append(label);
    if (member.role !== 'owner' && member.user_id !== session.user.id) {
      const remove = createCommunityButton('Remove', 'button secondary small', async (event) => {
        if (!window.confirm('Remove this member from the group?')) return;
        const button = event.currentTarget;
        await runGroupAction(button, async () => {
          const { error } = await supabase.rpc('remove_community_group_member', {
            target_group: group.id, target_user: member.user_id
          });
          if (error) throw error;
        }, 'Member removed.');
      });
      row.append(remove);
    }
    memberSection.append(row);
  });
  if (!members.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No member records are available.';
    memberSection.append(empty);
  }
  body.append(memberSection);

  const pendingRequests = groupsState.requests.filter((request) => request.group_id === group.id);
  const requestSection = document.createElement('section');
  requestSection.className = 'group-management-section';
  const requestHeading = document.createElement('h4');
  requestHeading.textContent = 'Join requests (' + pendingRequests.length + ')';
  requestSection.append(requestHeading);
  pendingRequests.forEach((request) => {
    const row = document.createElement('div');
    row.className = 'group-person-row';
    const requester = getGroupProfile(request.user_id);
    const label = document.createElement('span');
    label.className = 'group-person-name';
    label.textContent = (requester.display_name || requester.username) + ' · ' + formatCommunityDate(request.created_at);
    const buttons = document.createElement('div');
    buttons.className = 'group-person-actions';
    [['Approve', true], ['Reject', false]].forEach(([text, approve]) => {
      buttons.append(createCommunityButton(text, 'button secondary small', async (event) => {
        const button = event.currentTarget;
        await runGroupAction(button, async () => {
          const { error } = await supabase.rpc('decide_community_group_join_request', {
            target_request: request.id, approve_request: approve
          });
          if (error) throw error;
        }, approve ? 'Join request approved.' : 'Join request rejected.');
      }));
    });
    row.append(label, buttons);
    requestSection.append(row);
  });
  if (!pendingRequests.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No pending requests.';
    requestSection.append(empty);
  }
  body.append(requestSection);
  details.append(summary, body);
  return details;
}

async function runGroupAction(button, action, successMessage) {
  button.disabled = true;
  try {
    const actionMessage = await action();
    await loadGroups();
    if (isPortfolioOwner) await loadOwnerGroups();
    showStatus($('#groups-status'), actionMessage || successMessage, false);
  } catch (error) {
    showStatus($('#groups-status'), error.message || 'The group action failed.', true);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function loadOwnerGroups() {
  if (!isPortfolioOwner || !session) return;
  const output = $('#owner-groups-list');
  const groups = await fetchAllFeedRows(() => supabase.from('community_groups')
    .select('id, name, visibility, owner_id, avatar_path, created_at')
    .order('created_at', { ascending: false }));
  await loadGroupProfiles(groups.map((group) => group.owner_id));
  const countsResult = groups.length
    ? await supabase.rpc('community_group_member_counts', { target_group_ids: groups.map((group) => group.id) })
    : { data: [], error: null };
  if (countsResult.error) throw countsResult.error;
  const counts = new Map((countsResult.data || []).map((row) => [row.group_id, Number(row.member_count)]));
  output.replaceChildren();
  if (!groups.length) {
    output.textContent = 'No groups are currently available.';
    showStatus($('#owner-groups-status'), 'Group administration is ready.', false);
    return;
  }
  groups.forEach((group) => {
    const row = document.createElement('div');
    row.className = 'owner-group-row';
    const label = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = group.name;
    const metadata = document.createElement('small');
    metadata.textContent = group.visibility + ' · ' + (counts.get(group.id) || 0) + ' members · owner ' +
      (getGroupProfile(group.owner_id).display_name || getGroupProfile(group.owner_id).username);
    label.append(name, metadata);
    const remove = createCommunityButton('Delete group and content', 'button danger small', async (event) => {
      if (!window.confirm('Remove "' + group.name + '" and permanently delete its memberships, requests, and group messages?')) return;
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const { data, error: deleteError } = await supabase.from('community_groups')
          .delete().eq('id', group.id).select('id');
        if (deleteError) throw deleteError;
        if (!data || !data.length) throw new Error('The group could not be deleted.');
        closeGroupChatFor(group.id);
        let message = 'Group and associated content deleted.';
        if (group.avatar_path) {
          const { error: imageError } = await supabase.storage.from('community-avatars').remove([group.avatar_path]);
          if (imageError) message += ' Its image could not be removed: ' + imageError.message;
        }
        await Promise.all([loadGroups(), loadOwnerGroups()]);
        showStatus($('#owner-groups-status'), message, false);
      } catch (error) {
        showStatus($('#owner-groups-status'), error.message || 'Could not delete the group.', true);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
    row.append(label, remove);
    output.append(row);
  });
  showStatus($('#owner-groups-status'), 'Showing all groups. Private group messages remain visible only to group members.', false);
}

function subscribeToGroupDirectory() {
  if (groupDirectoryChannel) supabase.removeChannel(groupDirectoryChannel);
  groupDirectoryChannel = supabase.channel('community-group-directory')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'community_groups' }, () => {
      loadGroups().catch((error) => showStatus($('#groups-status'), error.message, true));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'community_group_members' }, () => {
      loadGroups().catch((error) => showStatus($('#groups-status'), error.message, true));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'community_group_join_requests' }, () => {
      loadGroups().catch((error) => showStatus($('#groups-status'), error.message, true));
    })
    .subscribe();
}

async function openGroupChat(group) {
  try {
    const { data, error } = await supabase.rpc('is_community_group_member', { target_group: group.id });
    if (error) throw error;
    if (data !== true) throw new Error('Only approved group members can open this discussion.');
    if (groupRealtimeChannel) await supabase.removeChannel(groupRealtimeChannel);
    groupRealtimeChannel = null;
    activeGroup = group;
    $('#group-messages').replaceChildren();
    $('#group-chat-title').textContent = group.name;
    $('#group-chat-description').textContent = group.description || '';
    $('#group-chat-panel').hidden = false;
    await loadGroupMessages();
    groupRealtimeChannel = supabase.channel('community-group-' + group.id)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'community_group_messages', filter: 'group_id=eq.' + group.id
      }, () => {
        if (activeGroup && activeGroup.id === group.id) {
          loadGroupMessages().catch((loadError) => showStatus($('#group-chat-status'), loadError.message, true));
        }
      })
      .subscribe();
    $('#group-chat-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showStatus($('#group-chat-status'), error.message || 'Could not open this group chat.', true);
  }
}

async function loadGroupMessages() {
  if (!activeGroup) return;
  const output = $('#group-messages');
  const { data: messages, error } = await supabase.from('community_group_messages')
    .select('id, group_id, sender_id, content, created_at')
    .eq('group_id', activeGroup.id).order('created_at', { ascending: true }).limit(200);
  if (error) throw error;
  await loadGroupProfiles(messages.map((message) => message.sender_id));
  output.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No messages yet. Start the conversation.';
    output.append(empty);
  } else {
    messages.forEach((message) => {
      const article = document.createElement('article');
      article.className = 'group-message';
      const heading = document.createElement('div');
      heading.className = 'group-message-heading';
      const sender = document.createElement('strong');
      const senderProfile = getGroupProfile(message.sender_id);
      sender.textContent = senderProfile.display_name || senderProfile.username;
      const time = document.createElement('time');
      time.dateTime = message.created_at;
      time.textContent = formatCommunityDate(message.created_at);
      heading.append(sender, time);
      const content = document.createElement('p');
      content.textContent = message.content;
      article.append(heading, content);
      output.append(article);
    });
  }
  output.scrollTop = output.scrollHeight;
  showStatus($('#group-chat-status'), 'Messages loaded.', false);
}

function closeGroupChatFor(groupId) {
  if (!activeGroup || activeGroup.id !== groupId) return;
  activeGroup = null;
  $('#group-chat-panel').hidden = true;
  $('#group-chat-title').textContent = '';
  $('#group-chat-description').textContent = '';
  $('#group-messages').replaceChildren();
  if (groupRealtimeChannel) {
    supabase.removeChannel(groupRealtimeChannel);
    groupRealtimeChannel = null;
  }
}

function validateGroupImage(file) {
  if (!file) return;
  if (!new Set(['image/jpeg', 'image/png', 'image/webp']).has(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error('Choose a JPEG, PNG, or WebP group image smaller than 5 MB.');
  }
}

function attachGroupHandlers() {
  $('#groups-refresh').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await loadGroups();
    } catch (error) {
      showStatus($('#groups-status'), error.message || 'Could not refresh groups.', true);
    } finally {
      button.disabled = false;
    }
  });
  $('#group-search').addEventListener('input', renderGroups);
  $('#group-chat-close').addEventListener('click', () => closeGroupChatFor(activeGroup && activeGroup.id));
  $('#group-create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const name = form.elements.name.value.trim();
    const description = form.elements.description.value.trim();
    const visibility = form.elements.visibility.value;
    const file = form.elements.image.files[0];
    const button = $('#group-create-submit');
    button.disabled = true;
    button.textContent = 'Creating…';
    let uploadedPath;
    let imageUploaded = false;
    try {
      validateGroupImage(file);
      if (name.length < 2) throw new Error('Group names must contain at least 2 characters.');
      if (file) {
        const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/png' ? 'png' : 'webp';
        uploadedPath = session.user.id + '/groups/' + crypto.randomUUID() + '.' + extension;
        const { error: uploadError } = await supabase.storage.from('community-avatars')
          .upload(uploadedPath, file, { contentType: file.type, upsert: false });
        if (uploadError) throw uploadError;
        imageUploaded = true;
      }
      const { error } = await supabase.from('community_groups').insert({
        owner_id: session.user.id, name, description, visibility, avatar_path: uploadedPath || null
      });
      if (error) throw error;
    } catch (error) {
      if (imageUploaded && uploadedPath) {
        const { error: cleanupError } = await supabase.storage.from('community-avatars').remove([uploadedPath]);
        if (cleanupError) {
          showStatus($('#group-create-status'), (error.message || 'Could not create the group.') +
            ' The uploaded image could not be removed: ' + cleanupError.message, true);
          return;
        }
      }
      showStatus($('#group-create-status'), error.message || 'Could not create the group.', true);
      return;
    } finally {
      button.disabled = false;
      button.textContent = 'Create group';
    }
    form.reset();
    showStatus($('#group-create-status'), 'Group created. You are its owner and first member.', false);
    try {
      await loadGroups();
      if (isPortfolioOwner) await loadOwnerGroups();
    } catch (error) {
      showStatus($('#groups-status'), 'Group created, but the list could not refresh: ' +
        (error.message || 'Unknown error.'), true);
    }
  });
  $('#group-message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeGroup) return;
    const textarea = $('#group-message-text');
    const content = textarea.value.trim();
    if (!content || content.length > 2000) {
      showStatus($('#group-chat-status'), 'Write between 1 and 2,000 characters.', true);
      return;
    }
    const button = $('#group-message-submit');
    button.disabled = true;
    try {
      const { error } = await supabase.from('community_group_messages').insert({
        group_id: activeGroup.id, sender_id: session.user.id, content
      });
      if (error) throw error;
      textarea.value = '';
      await loadGroupMessages();
    } catch (error) {
      showStatus($('#group-chat-status'), error.message || 'Could not send this message.', true);
    } finally {
      button.disabled = false;
    }
  });
}

async function initialize() {
  attachAuthHandlers();
  try {
    supabase = await connectSupabase();
    initializationError = null;
    resolveSupabaseInitialization(supabase);
    setBackendMessage('Connected to Supabase. Sign up or sign in to continue.', false);
    attachCommunityHandlers();
    attachGroupHandlers();
    handleUserSearch();
    attachMessageHandlers();
    supabase.auth.onAuthStateChange((_event, nextSession) => {
      window.setTimeout(() => setSession(nextSession).catch((error) => setBackendMessage(error.message, true)), 0);
    });
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    await setSession(data.session);
    window.setInterval(() => {
      if (session) updateLastSeen().catch((error) => setBackendMessage(error.message, true));
    }, 60000);
  } catch (error) {
    initializationError = error;
    resolveSupabaseInitialization(null);
    setBackendMessage(error.message || 'Unable to initialize the community backend.', true);
  }
}

initialize();
