
const goalAddBtn = document.getElementById("goal-add-btn");
const goalDeleteBtn = document.getElementById("goal-delete-btn");
const goalExpandBtn = document.getElementById("goal-expand-btn");
const goalListEl = document.getElementById("goal-list");
const goalContainer = document.querySelector(".goal-list-container");
const goalEmptyHint = document.getElementById("goal-empty-hint");
const leaveBtn = document.getElementById("leave-btn");
const sessionUserEl = document.getElementById("session-user");
const roomTitleEl = document.getElementById("room-title");
const themeToggle = document.getElementById("theme-toggle");
const focusLengthInput = document.getElementById("focus-length");
const breakLengthInput = document.getElementById("break-length");
const timerDisplay = document.getElementById("timer-display");
const timerStatus = document.getElementById("timer-status");
const participantsList = document.getElementById("participants");
const eventsList = document.getElementById("events");
const chatList = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const actionButtons = document.querySelectorAll(".actions button");
const mediaGrid = document.getElementById("media-grid");
const micBtn = document.getElementById("mic-btn");
const camBtn = document.getElementById("cam-btn");
const screenBtn = document.getElementById("screen-btn");
const leaderboardList = document.getElementById("leaderboard");

let socket = null;
let lastState = null;
let localUser = "";
let localStream = new MediaStream();
let screenStream = null;
let remoteMediaStates = {};

const peers = new Map();
const mediaTiles = new Map();
const mediaState = { audio: false, video: false, screen: false };
const tileVisibility = new Map();

const JOIN_SESSION_KEY = "studyRoomJoin";
const THEME_KEY = "studyRoomTheme";
const LEADERBOARD_PREFIX = "studyRoomLeaderboard:";
const GOAL_STORAGE_PREFIX = "studyRoomGoals:";
let currentRoomId = "";
let currentUserName = "";
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// 根据需要替换成自己的后端地址
const wsBase = "wss://api.（你的域名）";

let currentTheme = "dark";
let timerCycle = "focus";
let timerStatusState = "idle";
let timerRemaining = 0;
let timerIntervalId = null;
let timerLastTick = null;
let currentFocusPlanned = 0;
let focusSessionActive = false;
let leaderboardTotals = {};
let goals = [];
let goalStorageKey = "";
let goalDeleteMode = false;
let pendingGoalFocusId = "";
let leaderboardStorageKey = "";

function applyTheme(theme) {
  currentTheme = theme === "dark" ? "dark" : "light";
  const root = document.documentElement;
  if (currentTheme === "dark") {
    root.setAttribute("data-theme", "dark");
  } else {
    root.removeAttribute("data-theme");
  }
  if (themeToggle) {
    themeToggle.textContent = currentTheme === "dark" ? "切换浅色模式" : "切换暗夜模式";
  }
  try {
    localStorage.setItem(THEME_KEY, currentTheme);
  } catch (_) {
    /* ignore */
  }
}

try {
  const params = new URLSearchParams(window.location.search);
  const paramTheme = params.get("theme");
  const storedTheme = localStorage.getItem(THEME_KEY);
  if (paramTheme) {
    currentTheme = paramTheme;
  } else if (storedTheme) {
    currentTheme = storedTheme;
  }
} catch (_) {
  currentTheme = "dark";
}
applyTheme(currentTheme);

function getDurationSeconds(kind) {
  const input = kind === "focus" ? focusLengthInput : breakLengthInput;
  if (!input) {
    return (kind === "focus" ? 25 : 5) * 60;
  }
  const value = parseInt(input.value, 10);
  if (Number.isNaN(value) || value <= 0) {
    return (kind === "focus" ? 25 : 5) * 60;
  }
  return Math.min(value, kind === "focus" ? 300 : 180) * 60;
}

function updateTimerUI() {
  timerDisplay.textContent = formatSeconds(Math.max(0, timerRemaining));
  const statusText =
    timerStatusState === "running"
      ? "运行中"
      : timerStatusState === "paused"
        ? "已暂停"
        : "待开始";
  timerStatus.textContent = `${timerCycle === "focus" ? "专注" : "休息"} · ${statusText}`;
  const pauseButton = document.querySelector('button[data-action="pause"]');
  if (pauseButton) {
    pauseButton.textContent = timerStatusState === "paused" ? "继续" : "暂停";
  }
}

function initLocalTimer() {
  timerCycle = "focus";
  timerStatusState = "idle";
  timerRemaining = getDurationSeconds("focus");
  currentFocusPlanned = timerRemaining;
  focusSessionActive = false;
  clearInterval(timerIntervalId);
  timerIntervalId = null;
  timerLastTick = null;
  updateTimerUI();
}

function startLocalTimer(cycle) {
  timerCycle = cycle;
  timerRemaining = getDurationSeconds(cycle);
  if (cycle === "focus") {
    currentFocusPlanned = timerRemaining;
    focusSessionActive = true;
  } else {
    focusSessionActive = false;
    currentFocusPlanned = 0;
  }
  timerStatusState = "running";
  timerLastTick = Date.now();
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
  }
  timerIntervalId = window.setInterval(tickLocalTimer, 500);
  logItem(eventsList, `${cycle === "focus" ? "开始专注" : "开始休息"}（个人）`);
  updateTimerUI();
}

function resumeLocalTimer() {
  if (timerStatusState !== "paused") return;
  timerStatusState = "running";
  timerLastTick = Date.now();
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
  }
  timerIntervalId = window.setInterval(tickLocalTimer, 500);
  logItem(eventsList, "继续计时（个人）");
  updateTimerUI();
}

function pauseLocalTimer() {
  if (timerStatusState !== "running") return;
  timerStatusState = "paused";
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
  updateTimerUI();
}

function resetLocalTimer() {
  finalizeFocusSession();
  initLocalTimer();
  logItem(eventsList, "个人计时器已重置");
}

function skipLocalBreak() {
  if (timerCycle !== "break") return;
  logItem(eventsList, "跳过休息，重新进入专注");
  startLocalTimer("focus");
}

function tickLocalTimer() {
  if (timerStatusState !== "running") return;
  const now = Date.now();
  const delta = Math.floor((now - timerLastTick) / 1000);
  if (delta <= 0) {
    return;
  }
  timerLastTick = now;
  timerRemaining = Math.max(0, timerRemaining - delta);
  updateTimerUI();
  if (timerRemaining <= 0) {
    completeLocalCycle();
  }
}

function completeLocalCycle() {
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
  if (timerCycle === "focus") {
    finalizeFocusSession();
    logItem(eventsList, "专注完成，自动进入休息");
    startLocalTimer("break");
  } else {
    logItem(eventsList, "休息结束，回到待开始状态");
    timerCycle = "focus";
    timerStatusState = "idle";
    timerRemaining = getDurationSeconds("focus");
    currentFocusPlanned = timerRemaining;
    focusSessionActive = false;
    updateTimerUI();
  }
}

function finalizeFocusSession() {
  if (!focusSessionActive || timerCycle !== "focus") {
    focusSessionActive = false;
    return;
  }
  const planned = currentFocusPlanned || 0;
  if (planned <= 0) {
    focusSessionActive = false;
    return;
  }
  const elapsed = planned - timerRemaining;
  const effective = Math.max(0, Math.min(planned, elapsed));
  if (effective > 0) {
    addLeaderboardDuration(getLeaderboardUser(), effective);
  }
  focusSessionActive = false;
}

function readJoinPayload() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("room") || params.has("name") || params.has("goal")) {
    return {
      room: params.get("room") || "",
      name: params.get("name") || "",
      goal: params.get("goal") || "",
    };
  }
  try {
    const stored = sessionStorage.getItem(JOIN_SESSION_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function updateSessionMeta() {
  if (sessionUserEl) {
    sessionUserEl.textContent = currentUserName || "-";
  }
  if (roomTitleEl) {
    roomTitleEl.textContent = currentRoomId ? `房间：${currentRoomId}` : "线上自习室";
  }
}

const initialJoin = readJoinPayload();
if (!initialJoin || !initialJoin.room || !initialJoin.name) {
  window.location.replace("join.html");
} else {
  currentRoomId = initialJoin.room.trim();
  currentUserName = initialJoin.name.trim();
  setGoalContext(currentRoomId, currentUserName);
  seedInitialGoal(initialJoin.goal || "");
  updateSessionMeta();
  setLeaderboardRoom(currentRoomId);
}

function formatSeconds(total) {
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(Math.floor(total % 60)).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function generateGoalId() {
  return `goal-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function setGoalContext(roomId, user) {
  const sanitizedRoom = (roomId || "").trim();
  const sanitizedUser = (user || "").trim();
  const nextKey = sanitizedRoom && sanitizedUser ? `${GOAL_STORAGE_PREFIX}${sanitizedRoom}:${sanitizedUser}` : "";
  if (goalStorageKey === nextKey) {
    return;
  }
  goalStorageKey = nextKey;
  loadGoalsFromStorage();
}

function loadGoalsFromStorage() {
  goals = [];
  if (!goalStorageKey) {
    renderGoals();
    return;
  }
  try {
    const raw = localStorage.getItem(goalStorageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        goals = parsed
          .map((entry) => ({
            id: typeof entry.id === "string" ? entry.id : generateGoalId(),
            text: typeof entry.text === "string" ? entry.text : "",
            completed: Boolean(entry.completed),
          }))
          .slice(0, 200);
      }
    }
  } catch (_) {
    goals = [];
  }
  renderGoals();
}

function persistGoals() {
  if (!goalStorageKey) return;
  try {
    localStorage.setItem(
      goalStorageKey,
      JSON.stringify(
        goals.map((goal) => ({
          id: goal.id,
          text: goal.text,
          completed: goal.completed,
        })),
      ),
    );
  } catch (_) {
    /* ignore */
  }
}

function renderGoals() {
  if (!goalListEl || !goalContainer) return;
  goalListEl.innerHTML = "";
  const fragment = document.createDocumentFragment();
  goals.forEach((goal) => {
    const li = document.createElement("li");
    li.className = "goal-item";
    li.dataset.id = goal.id;
    li.dataset.complete = String(goal.completed);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "goal-remove";
    removeBtn.dataset.id = goal.id;
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", "删除目标");
    removeBtn.hidden = !goalDeleteMode;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "goal-text";
    input.placeholder = "写下目标...";
    input.value = goal.text;
    input.dataset.id = goal.id;
    input.dataset.complete = String(goal.completed);

    const controls = document.createElement("div");
    controls.className = "goal-controls";

    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "goal-check";
    checkBtn.dataset.id = goal.id;
    checkBtn.dataset.complete = String(goal.completed);
    checkBtn.setAttribute("aria-label", goal.completed ? "取消完成" : "标记完成");

    controls.append(checkBtn);
    li.append(removeBtn, input, controls);
    fragment.appendChild(li);
  });
  goalListEl.appendChild(fragment);
  goalContainer.dataset.empty = String(goals.length === 0);
  goalContainer.dataset.deleteMode = String(goalDeleteMode && goals.length > 0);
  if (goalEmptyHint) {
    goalEmptyHint.hidden = goals.length > 0;
  }
  updateGoalUtilityButtons();
  focusPendingGoalInput();
}

function updateGoalUtilityButtons() {
  if (goalDeleteBtn) {
    const hasGoals = goals.length > 0;
    goalDeleteBtn.disabled = !hasGoals;
    goalDeleteBtn.hidden = !hasGoals;
    goalDeleteBtn.dataset.active = String(goalDeleteMode);
  }
  if (goalExpandBtn && goalContainer) {
    const shouldShow = goals.length > 3;
    goalExpandBtn.hidden = !shouldShow;
    if (!shouldShow) {
      goalContainer.dataset.expanded = "false";
    }
    const expanded = goalContainer.dataset.expanded === "true";
    goalExpandBtn.textContent = expanded ? "收起" : "展开全部";
  }
}

function focusPendingGoalInput() {
  if (!pendingGoalFocusId || !goalListEl) return;
  const targetInput = goalListEl.querySelector(`.goal-text[data-id="${pendingGoalFocusId}"]`);
  pendingGoalFocusId = "";
  if (targetInput) {
    targetInput.focus();
    targetInput.select();
  }
}

function addGoalItem(initialText = "", { focus = true } = {}) {
  const newGoal = {
    id: generateGoalId(),
    text: initialText,
    completed: false,
  };
  goals.push(newGoal);
  persistGoals();
  pendingGoalFocusId = focus && !initialText ? newGoal.id : "";
  renderGoals();
}

function seedInitialGoal(text) {
  const value = (text || "").trim();
  if (!value || goals.length > 0) return;
  addGoalItem(value, { focus: false });
}

function updateGoalText(goalId, text) {
  const target = goals.find((goal) => goal.id === goalId);
  if (!target) return;
  target.text = text.slice(0, 140);
  persistGoals();
}

function toggleGoalComplete(goalId) {
  const target = goals.find((goal) => goal.id === goalId);
  if (!target) return;
  target.completed = !target.completed;
  persistGoals();
  renderGoals();
}

function removeGoal(goalId) {
  const next = goals.filter((goal) => goal.id !== goalId);
  if (next.length === goals.length) return;
  goals = next;
  if (!goals.length) {
    goalDeleteMode = false;
  }
  persistGoals();
  renderGoals();
}

function toggleGoalDeleteMode() {
  if (!goals.length) {
    goalDeleteMode = false;
    updateGoalUtilityButtons();
    return;
  }
  goalDeleteMode = !goalDeleteMode;
  renderGoals();
}

function toggleGoalExpanded() {
  if (!goalContainer || !goalExpandBtn) return;
  const next = goalContainer.dataset.expanded !== "true";
  goalContainer.dataset.expanded = String(next);
  goalExpandBtn.textContent = next ? "收起" : "展开全部";
}

function handleGoalListInput(event) {
  const target = event.target;
  if (!target.classList.contains("goal-text")) return;
  const goalId = target.dataset.id;
  updateGoalText(goalId, target.value);
}

function handleGoalListKey(event) {
  if (event.key !== "Enter") return;
  if (!event.target.classList.contains("goal-text")) return;
  event.preventDefault();
  event.target.blur();
}

function handleGoalListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.classList.contains("goal-check")) {
    const goalId = target.dataset.id;
    toggleGoalComplete(goalId);
    return;
  }
  if (target.classList.contains("goal-remove")) {
    const goalId = target.dataset.id;
    removeGoal(goalId);
  }
}

if (goalAddBtn) {
  goalAddBtn.addEventListener("click", () => {
    addGoalItem();
  });
}

if (goalDeleteBtn) {
  goalDeleteBtn.addEventListener("click", () => {
    toggleGoalDeleteMode();
  });
}

if (goalExpandBtn) {
  goalExpandBtn.addEventListener("click", () => {
    toggleGoalExpanded();
  });
}

if (goalListEl) {
  goalListEl.addEventListener("input", handleGoalListInput);
  goalListEl.addEventListener("keydown", handleGoalListKey);
  goalListEl.addEventListener("click", handleGoalListClick);
}

function getLeaderboardUser() {
  const name = (localUser || currentUserName || "").trim();
  return name || "未命名";
}

function setLeaderboardRoom(roomId) {
  leaderboardStorageKey = roomId ? `${LEADERBOARD_PREFIX}${roomId}` : "";
  leaderboardTotals = {};
  if (leaderboardStorageKey) {
    try {
      const raw = localStorage.getItem(leaderboardStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          Object.entries(parsed).forEach(([user, value]) => {
            const seconds = Number(value);
            if (!Number.isNaN(seconds) && seconds > 0) {
              leaderboardTotals[user] = seconds;
            }
          });
        }
      }
    } catch (_) {
      leaderboardTotals = {};
    }
  }
  renderLeaderboard();
}

function persistLeaderboard() {
  if (!leaderboardStorageKey) return;
  try {
    localStorage.setItem(leaderboardStorageKey, JSON.stringify(leaderboardTotals));
  } catch (_) {
    /* ignore */
  }
}

function renderLeaderboard() {
  if (!leaderboardList) return;
  leaderboardList.innerHTML = "";
  const entries = Object.entries(leaderboardTotals);
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.textContent = "暂无番茄钟记录";
    leaderboardList.appendChild(empty);
    return;
  }
  entries
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, seconds], index) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${index + 1}. ${name}`;
      const value = document.createElement("span");
      value.textContent = `| ${formatSeconds(Math.max(0, Math.floor(seconds)))}`;
      li.append(label, value);
      leaderboardList.appendChild(li);
    });
}

function addLeaderboardDuration(user, seconds) {
  const normalized = Math.max(0, Math.floor(seconds || 0));
  if (!user || normalized <= 0) return;
  const key = user.trim() || "未命名";
  leaderboardTotals[key] = (leaderboardTotals[key] || 0) + normalized;
  persistLeaderboard();
  renderLeaderboard();
}

function clearLeaderboardUser(user) {
  const key = (user || "").trim();
  if (!key) return;
  if (leaderboardTotals[key]) {
    delete leaderboardTotals[key];
    persistLeaderboard();
    renderLeaderboard();
  }
}

function logItem(listEl, text) {
  if (!listEl) return;
  const li = document.createElement("li");
  li.textContent = text;
  listEl.prepend(li);
  if (listEl.childElementCount > 50) {
    listEl.removeChild(listEl.lastChild);
  }
}

function renderState(state) {
  lastState = state;

  if (participantsList) {
    participantsList.innerHTML = "";
  }
  state.participants.forEach((name) => {
    if (participantsList) {
      const li = document.createElement("li");
      li.textContent = name;
      participantsList.appendChild(li);
    }
    ensureMediaTile(name);
  });

  pruneMediaTiles(state.participants);
  syncPeers(state.participants);

  const mediaStates = state.media_states || {};
  Object.entries(mediaStates).forEach(([user, details]) => {
    updateRemoteMedia(user, details);
  });

}

function setControlsEnabled(enabled) {
  actionButtons.forEach((btn) => {
    btn.disabled = !enabled;
  });
  chatInput.disabled = !enabled;
  if (focusLengthInput) focusLengthInput.disabled = !enabled;
  if (breakLengthInput) breakLengthInput.disabled = !enabled;
  setMediaButtonsEnabled(enabled);
}

function setMediaButtonsEnabled(enabled) {
  [micBtn, camBtn, screenBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = !enabled;
  });
  setMediaButtonsState();
}

function sendMessage(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function connectRoom() {
  if (socket) {
    socket.close();
  }

  const roomId = currentRoomId;
  if (!roomId) {
    timerStatus.textContent = "请先填写房间 ID";
    window.location.replace("join.html");
    return;
  }
  const user = currentUserName || "访客";
  if (!user) {
    timerStatus.textContent = "请先填写昵称";
    window.location.replace("join.html");
    return;
  }
  if (localUser && localUser !== user) {
    removeMediaTile(localUser);
  }
  localUser = user;
  setGoalContext(currentRoomId, localUser);
  remoteMediaStates = {};
  ensureMediaTile(user);
  updateLocalTile();

  const wsUrl = `${wsBase}/ws/rooms/${encodeURIComponent(roomId)}`;
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    timerStatus.textContent = "连接成功";
    sendMessage({ type: "join", user });
    setControlsEnabled(true);
    leaveBtn.disabled = false;
    sendMediaUpdate();
  });

  socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case "state":
        renderState(data.data);
        break;
      case "chat":
        logItem(chatList, `${data.user || "匿名"}: ${data.text}`);
        break;
      case "event":
        logItem(eventsList, data.event + (data.user ? ` (${data.user})` : ""));
        break;
      case "media:update":
        updateRemoteMedia(data.user, data.media || {});
        break;
      case "webrtc:offer":
        if (data.target === localUser) {
          await handleOffer(data);
        }
        break;
      case "webrtc:answer":
        if (data.target === localUser) {
          await handleAnswer(data);
        }
        break;
      case "webrtc:candidate":
        if (data.target === localUser) {
          await handleCandidate(data);
        }
        break;
      default:
        break;
    }
  });

  socket.addEventListener("close", () => {
    timerStatus.textContent = "已断开";
    setControlsEnabled(false);
    leaveBtn.disabled = true;
    cleanupPeers();
    stopAllMedia();
  });

  socket.addEventListener("error", () => {
    timerStatus.textContent = "连接出错";
  });
}

function ensureMediaTile(user) {
  if (!mediaGrid || mediaTiles.has(user)) {
    return mediaTiles.get(user);
  }
  getTilePrefs(user);
  const tile = document.createElement("article");
  tile.className = "media-tile";
  tile.dataset.user = user;

  const header = document.createElement("div");
  header.className = "media-tile__header";
  const nameEl = document.createElement("strong");
  nameEl.textContent = user;
  const statusEl = document.createElement("span");
  statusEl.className = "media-tile__status";
  statusEl.textContent = "未开启设备";
  header.append(nameEl, statusEl);

  const cameraVideo = document.createElement("video");
  cameraVideo.autoplay = true;
  cameraVideo.playsInline = true;
  cameraVideo.hidden = true;
  cameraVideo.dataset.kind = "camera";
  if (user === localUser) {
    cameraVideo.muted = true;
  }

  const screenVideo = document.createElement("video");
  screenVideo.autoplay = true;
  screenVideo.playsInline = true;
  screenVideo.hidden = true;
  screenVideo.dataset.kind = "screen";
  if (user === localUser) {
    screenVideo.muted = true;
  }

  const placeholder = document.createElement("div");
  placeholder.className = "media-placeholder";
  placeholder.textContent = "暂无画面";

  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.hidden = true;

  const toggleBar = document.createElement("div");
  toggleBar.className = "media-tile__toggles";
  const cameraToggle = document.createElement("button");
  cameraToggle.type = "button";
  cameraToggle.className = "media-toggle";
  cameraToggle.dataset.kind = "camera";
  cameraToggle.dataset.active = "true";
  cameraToggle.textContent = "摄像头";
  const screenToggle = document.createElement("button");
  screenToggle.type = "button";
  screenToggle.className = "media-toggle";
  screenToggle.dataset.kind = "screen";
  screenToggle.dataset.active = "true";
  screenToggle.textContent = "屏幕";
  toggleBar.append(cameraToggle, screenToggle);

  tile.append(header, toggleBar, cameraVideo, screenVideo, placeholder, audioEl);
  mediaGrid.appendChild(tile);

  [cameraVideo, screenVideo].forEach((video) => {
    video.addEventListener("click", () => {
      tile.classList.toggle("expanded");
    });
  });

  cameraToggle.addEventListener("click", () => {
    toggleTileSection(user, "camera");
  });
  screenToggle.addEventListener("click", () => {
    toggleTileSection(user, "screen");
  });

  const info = {
    tile,
    statusEl,
    cameraVideo,
    screenVideo,
    placeholder,
    audioEl,
    cameraToggle,
    screenToggle,
  };
  mediaTiles.set(user, info);
  applyTileVisibility(user);
  return info;
}

function removeMediaTile(user) {
  const info = mediaTiles.get(user);
  if (!info) return;
  if (info.cameraVideo.srcObject) {
    info.cameraVideo.srcObject = null;
  }
  if (info.screenVideo.srcObject) {
    info.screenVideo.srcObject = null;
  }
  if (info.audioEl.srcObject) {
    info.audioEl.pause();
    info.audioEl.srcObject = null;
  }
  info.tile.remove();
  mediaTiles.delete(user);
  tileVisibility.delete(user);
}

function updateTileStatus(user, state) {
  const info = ensureMediaTile(user);
  if (!info) return;
  const flags = [];
  if (state?.audio) flags.push("麦克风");
  if (state?.video) flags.push("摄像头");
  if (state?.screen) flags.push("屏幕");
  info.statusEl.textContent = flags.length ? `${flags.join(" / ")} 已开启` : "未开启设备";
}

function updateRemoteMedia(user, state = {}) {
  remoteMediaStates[user] = state;
  updateTileStatus(user, state);
  if (!state.screen && user !== localUser) {
    const info = mediaTiles.get(user);
    if (info && info.screenVideo.srcObject) {
      info.screenVideo.srcObject = null;
    }
  }
  if (!state.video && user !== localUser) {
    const info = mediaTiles.get(user);
    if (info && info.cameraVideo.srcObject) {
      info.cameraVideo.srcObject = null;
    }
  }
  applyTileVisibility(user);
}

function pruneMediaTiles(participants) {
  const keep = new Set(participants);
  keep.add(localUser);
  Array.from(mediaTiles.keys()).forEach((user) => {
    if (!keep.has(user)) {
      removeMediaTile(user);
      delete remoteMediaStates[user];
    }
  });
}

function setMediaButtonsState() {
  if (micBtn) {
    micBtn.dataset.active = String(mediaState.audio);
    micBtn.textContent = mediaState.audio ? "麦克风已开启" : "麦克风已关闭";
  }
  if (camBtn) {
    camBtn.dataset.active = String(mediaState.video);
    camBtn.textContent = mediaState.video ? "摄像头已开启" : "摄像头已关闭";
  }
  if (screenBtn) {
    screenBtn.dataset.active = String(mediaState.screen);
    screenBtn.textContent = mediaState.screen ? "正在分享屏幕" : "未分享屏幕";
  }
}

function getTilePrefs(user) {
  if (!tileVisibility.has(user)) {
    tileVisibility.set(user, { camera: true, screen: true });
  }
  return tileVisibility.get(user);
}

function toggleTileSection(user, kind) {
  const prefs = getTilePrefs(user);
  prefs[kind] = !prefs[kind];
  applyTileVisibility(user);
}

function hasActiveStream(videoEl) {
  const stream = videoEl.srcObject;
  if (!stream) return false;
  return stream.getTracks().some((track) => track.readyState === "live");
}

function applyTileVisibility(user) {
  const info = mediaTiles.get(user);
  if (!info) return;
  const prefs = getTilePrefs(user);
  const cameraStream = hasActiveStream(info.cameraVideo);
  const screenStream = hasActiveStream(info.screenVideo);

  const showCamera = prefs.camera && cameraStream;
  const showScreen = prefs.screen && screenStream;

  info.cameraVideo.hidden = !showCamera;
  info.screenVideo.hidden = !showScreen;

  if (info.cameraToggle) {
    info.cameraToggle.dataset.active = String(showCamera);
    info.cameraToggle.disabled = !cameraStream;
  }
  if (info.screenToggle) {
    info.screenToggle.dataset.active = String(showScreen);
    info.screenToggle.disabled = !screenStream;
  }

  const anyStream = cameraStream || screenStream;
  const anyVisible = showCamera || showScreen;
  info.placeholder.hidden = anyVisible;
  info.placeholder.dataset.folded = String(anyStream && !anyVisible);
  info.placeholder.textContent = anyStream && !anyVisible ? "画面已折叠" : "暂无画面";
}

function syncPeers(participants) {
  if (!localUser) return;
  const others = participants.filter((name) => name && name !== localUser);
  peers.forEach((_entry, user) => {
    if (!others.includes(user)) {
      closePeer(user);
      peers.delete(user);
    }
  });
  others.forEach((user) => {
    const peer = ensurePeer(user);
    if (shouldInitiate(user) && !peer.initialOfferSent) {
      peer.initialOfferSent = true;
      negotiateWith(user).catch((err) => console.error("offer error", err));
    }
  });
}

function shouldInitiate(remoteUser) {
  if (!localUser) return false;
  return localUser.localeCompare(remoteUser) > 0;
}

function ensurePeer(user) {
  if (peers.has(user)) {
    return peers.get(user);
  }
  const pc = new RTCPeerConnection(rtcConfig);
  const peer = {
    pc,
    senders: { audio: null, video: null, screen: null },
    makingOffer: false,
    initialOfferSent: false,
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendMessage({ type: "webrtc:candidate", user: localUser, target: user, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => handleRemoteTrack(user, event);

  pc.onnegotiationneeded = async () => {
    if (shouldInitiate(user)) {
      await negotiateWith(user);
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      closePeer(user);
    }
  };

  peers.set(user, peer);
  syncPeerSender(peer, "audio");
  syncPeerSender(peer, "video");
  syncPeerSender(peer, "screen");
  return peer;
}

function closePeer(user) {
  const peer = peers.get(user);
  if (!peer) return;
  Object.values(peer.senders).forEach((sender) => {
    if (!sender) return;
    try {
      peer.pc.removeTrack(sender);
    } catch (_) {
      /* noop */
    }
  });
  peer.pc.close();
  peers.delete(user);
}

function syncPeerSender(peer, kind) {
  let track = null;
  let stream = null;
  if (kind === "audio") {
    track = localStream.getAudioTracks()[0] || null;
    stream = localStream;
  } else if (kind === "video") {
    track = localStream.getVideoTracks()[0] || null;
    stream = localStream;
  } else if (kind === "screen") {
    track = screenStream?.getVideoTracks()[0] || null;
    stream = screenStream;
  }

  const current = peer.senders[kind];

  if (track && stream) {
    if (current) {
      current.replaceTrack(track);
    } else {
      peer.senders[kind] = peer.pc.addTrack(track, stream);
    }
  } else if (current) {
    try {
      peer.pc.removeTrack(current);
    } catch (_) {
      /* noop */
    }
    peer.senders[kind] = null;
  }
}

async function negotiateWith(user) {
  const peer = ensurePeer(user);
  if (peer.makingOffer) return;
  try {
    peer.makingOffer = true;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    sendMessage({ type: "webrtc:offer", user: localUser, target: user, sdp: offer });
  } finally {
    peer.makingOffer = false;
  }
}

async function handleOffer(message) {
  const peer = ensurePeer(message.user);
  if (!message.sdp) return;
  await peer.pc.setRemoteDescription(message.sdp);
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  sendMessage({ type: "webrtc:answer", user: localUser, target: message.user, sdp: answer });
}

async function handleAnswer(message) {
  const peer = peers.get(message.user);
  if (!peer) return;
  if (!message.sdp) return;
  await peer.pc.setRemoteDescription(message.sdp);
}

async function handleCandidate(message) {
  const peer = peers.get(message.user);
  if (!peer || !message.candidate) return;
  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
  } catch (error) {
    console.error("candidate error", error);
  }
}

function handleRemoteTrack(user, event) {
  const [stream] = event.streams;
  if (!stream) return;
  const info = ensureMediaTile(user);
  if (!info) return;

  if (event.track.kind === "audio") {
    info.audioEl.srcObject = stream;
    info.audioEl.hidden = false;
    info.audioEl.play().catch(() => {});
    event.track.onended = () => {
      info.audioEl.srcObject = null;
      info.audioEl.hidden = true;
    };
    return;
  }

  const wantsScreen = remoteMediaStates[user]?.screen;
  const screenActive = info.screenVideo.srcObject && info.screenVideo.srcObject.active;
  const useScreenSlot = wantsScreen && (!screenActive || !info.cameraVideo.srcObject);
  const target = useScreenSlot ? info.screenVideo : info.cameraVideo;
  target.srcObject = stream;
  applyTileVisibility(user);
  event.track.onended = () => {
    target.srcObject = null;
    applyTileVisibility(user);
  };
  applyTileVisibility(user);
}

async function toggleMic() {
  if (mediaState.audio) {
    stopAudioTracks();
    mediaState.audio = false;
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getAudioTracks().forEach((track) => {
        localStream.addTrack(track);
      });
      mediaState.audio = true;
    } catch (error) {
      logItem(eventsList, `麦克风授权失败：${error.message}`);
    }
  }
  peers.forEach((peer) => syncPeerSender(peer, "audio"));
  updateLocalTile();
  setMediaButtonsState();
  sendMediaUpdate();
}

async function toggleCamera() {
  if (mediaState.video) {
    stopVideoTracks();
    mediaState.video = false;
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      stream.getVideoTracks().forEach((track) => {
        localStream.addTrack(track);
      });
      mediaState.video = true;
    } catch (error) {
      logItem(eventsList, `摄像头授权失败：${error.message}`);
    }
  }
  peers.forEach((peer) => syncPeerSender(peer, "video"));
  updateLocalTile();
  setMediaButtonsState();
  sendMediaUpdate();
}

async function toggleScreenShare() {
  if (mediaState.screen) {
    stopScreenShare();
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const [track] = screenStream.getVideoTracks();
    if (track) {
      track.addEventListener("ended", () => stopScreenShare());
    }
    mediaState.screen = true;
    peers.forEach((peer) => syncPeerSender(peer, "screen"));
    updateLocalTile();
    setMediaButtonsState();
    sendMediaUpdate();
  } catch (error) {
    logItem(eventsList, `屏幕分享失败：${error.message}`);
  }
}

function stopAudioTracks() {
  localStream.getAudioTracks().forEach((track) => {
    track.stop();
    localStream.removeTrack(track);
  });
}

function stopVideoTracks() {
  localStream.getVideoTracks().forEach((track) => {
    track.stop();
    localStream.removeTrack(track);
  });
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }
  mediaState.screen = false;
  peers.forEach((peer) => syncPeerSender(peer, "screen"));
  updateLocalTile();
  setMediaButtonsState();
  sendMediaUpdate();
}

function stopAllMedia() {
  stopAudioTracks();
  stopVideoTracks();
  stopScreenShare();
  mediaState.audio = false;
  mediaState.video = false;
  mediaState.screen = false;
  setMediaButtonsState();
  updateLocalTile();
}

function cleanupPeers() {
  peers.forEach((_, user) => closePeer(user));
  peers.clear();
  remoteMediaStates = {};
  mediaTiles.forEach((info, user) => {
    if (user !== localUser) {
      removeMediaTile(user);
    } else {
      info.cameraVideo.srcObject = null;
      info.screenVideo.srcObject = null;
      applyTileVisibility(user);
    }
  });
}

function updateLocalTile() {
  if (!localUser) return;
  const info = ensureMediaTile(localUser);
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack && mediaState.video) {
    info.cameraVideo.srcObject = localStream;
  } else {
    info.cameraVideo.srcObject = null;
  }

  if (screenStream && mediaState.screen) {
    info.screenVideo.srcObject = screenStream;
  } else {
    info.screenVideo.srcObject = null;
  }

  applyTileVisibility(localUser);
  updateTileStatus(localUser, mediaState);
}

function sendMediaUpdate() {
  if (!localUser) return;
  sendMessage({ type: "media:update", user: localUser, media: { ...mediaState } });
}

leaveBtn.addEventListener("click", () => {
  const departingUser = localUser || currentUserName;
  if (departingUser) {
    clearLeaderboardUser(departingUser);
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendMessage({ type: "leave", user: localUser || currentUserName });
    socket.close();
  }
  sessionStorage.removeItem(JOIN_SESSION_KEY);
  window.location.href = "join.html";
});

function handleTimerAction(action) {
  switch (action) {
    case "start_focus":
      startLocalTimer("focus");
      break;
    case "start_break":
      startLocalTimer("break");
      break;
    case "pause":
      if (timerStatusState === "running") {
        pauseLocalTimer();
      } else if (timerStatusState === "paused") {
        resumeLocalTimer();
      }
      break;
    case "skip_break":
      skipLocalBreak();
      break;
    case "reset":
      resetLocalTimer();
      break;
    default:
      break;
  }
}

actionButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    handleTimerAction(action);
  });
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendMessage({ type: "chat", user: localUser || currentUserName, text });
  chatInput.value = "";
});

if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    applyTheme(currentTheme === "dark" ? "light" : "dark");
  });
}

function handleLengthInputChange(kind) {
  if (timerStatusState !== "idle") {
    return;
  }
  if (kind === timerCycle) {
    timerRemaining = getDurationSeconds(kind);
    updateTimerUI();
  }
}

if (focusLengthInput) {
  focusLengthInput.addEventListener("change", () => handleLengthInputChange("focus"));
  focusLengthInput.addEventListener("input", () => handleLengthInputChange("focus"));
}

if (breakLengthInput) {
  breakLengthInput.addEventListener("change", () => handleLengthInputChange("break"));
  breakLengthInput.addEventListener("input", () => handleLengthInputChange("break"));
}

if (micBtn) {
  micBtn.addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    toggleMic();
  });
}

if (camBtn) {
  camBtn.addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    toggleCamera();
  });
}

if (screenBtn) {
  screenBtn.addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    toggleScreenShare();
  });
}

window.addEventListener("beforeunload", () => {
  const departingUser = localUser || currentUserName;
  if (departingUser) {
    clearLeaderboardUser(departingUser);
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendMessage({ type: "leave", user: localUser || currentUserName });
    socket.close();
  }
});

setControlsEnabled(false);
setMediaButtonsState();
initLocalTimer();

if (initialJoin) {
  connectRoom();
}
