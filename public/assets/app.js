const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}/ws`;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let messageQueue = [];

let myId = null;
let selectedHandCards = new Set();
let selectedTableCards = new Set();
let gameState = null;
let lastChatLength = 0;
let prevTableSnapshot = '';

// Sound Effects
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playSound(frequency, type, duration, volume = 0.05) {
    try {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
        gain.gain.setValueAtTime(volume, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    } catch (e) { console.warn(e); }
}
const sounds = {
    play: () => playSound(880, 'sine', 0.1, 0.05),
    take: () => playSound(660, 'sine', 0.05, 0.03),
    discard: () => playSound(440, 'triangle', 0.15, 0.02)
};

// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const playerNameInput = document.getElementById('player-name');
const roomIdInput = document.getElementById('room-id');
const btnJoin = document.getElementById('btn-join');

const displayRoomId = document.getElementById('display-room-id');
const playerList = document.getElementById('player-list');
const btnStart = document.getElementById('btn-start');
const btnQuit = document.getElementById('btn-quit');

const tableCards = document.getElementById('table-cards');
const myHand = document.getElementById('my-hand');

const btnPlay = document.getElementById('btn-play');
const btnTake = document.getElementById('btn-take');
const btnDiscard = document.getElementById('btn-discard');

const systemTicker = document.getElementById('system-ticker');
const tickerText = systemTicker.querySelector('span');
let tickerQueue = [];
let isTickerBusy = false;

function processTicker() {
    if (isTickerBusy || tickerQueue.length === 0) return;
    isTickerBusy = true;

    const message = tickerQueue.shift();
    tickerText.innerHTML = formatActivity(message);

    // Scroll In
    systemTicker.style.transform = 'translateY(0)';

    setTimeout(() => {
        // Scroll Out
        systemTicker.style.transform = 'translateY(-100%)';
        
        setTimeout(() => {
            // Reset for next message
            systemTicker.style.transition = 'none';
            systemTicker.style.transform = 'translateY(100%)';
            
            // Re-enable transition for next time
            setTimeout(() => {
                systemTicker.style.transition = '';
                isTickerBusy = false;
                processTicker();
            }, 50);
        }, 500);
    }, 2500);
}

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const chatToggle = document.getElementById('chat-toggle');
const chatPopup = document.getElementById('chat-popup');
const chatClose = document.getElementById('chat-close');
const chatBadge = document.getElementById('chat-badge');
const toastContainer = document.getElementById('toast-container');

// Scoreboard Elements
const scoreboardToggle = document.getElementById('scoreboard-toggle');
const scoreboardModal = document.getElementById('scoreboard-modal');
const scoreboardClose = document.getElementById('scoreboard-close');
const scoreboardList = document.getElementById('scoreboard-list');
const btnSaveScores = document.getElementById('btn-save-scores');
let localScores = {};

const menuToggle = document.getElementById('menu-toggle');
const mainMenu = document.getElementById('main-menu');

// Toggle Menu
menuToggle.onclick = (e) => {
    e.stopPropagation();
    mainMenu.classList.toggle('hidden');
};

// Close menu on click outside
window.addEventListener('click', () => {
    mainMenu.classList.add('hidden');
});

// Close menu when a menu item is clicked
mainMenu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
        mainMenu.classList.add('hidden');
    });
});

// Quit from mobile menu
document.getElementById('btn-quit-menu')?.addEventListener('click', () => {
    if (!confirm("Are you sure you want to quit this room?")) return;
    sendSocketMessage({ type: "LEAVE_ROOM" });
    localStorage.removeItem('flip52_player_id');
    localStorage.removeItem('flip52_player_name');
    gameState = null;
    myId = null;
    lastChatLength = 0;
    loginOverlay.classList.remove('hidden');
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url);
});

function showToast(name, message) {
    const toast = document.createElement('div');
    const initials = (name || '??').slice(0, 2).toUpperCase();
    toast.className = 'bg-white dark:bg-gray-800 shadow-lg border border-gray-100 dark:border-gray-700 p-2 rounded-2xl pointer-events-auto flex items-center gap-2.5 pr-4 max-w-xs cursor-pointer toast-enter';
    toast.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-blue-600 dark:bg-blue-500 flex items-center justify-center text-white text-[11px] font-black shrink-0 shadow-sm">
            ${initials}
        </div>
        <div class="text-gray-600 dark:text-gray-300 text-[13px] break-words leading-tight font-medium">
            ${message}
        </div>
    `;
    
    toastContainer.appendChild(toast);
    
    // Animate In
    requestAnimationFrame(() => {
        toast.classList.remove('toast-enter');
        toast.classList.add('toast-enter-active');
    });

    // Animate Out
    setTimeout(() => {
        toast.classList.remove('toast-enter-active');
        toast.classList.add('toast-exit-active');
        setTimeout(() => toast.remove(), 300);
    }, 4000);

    toast.onclick = () => {
        chatToggle.click();
        toast.remove();
    };
}

// Theme Toggle
const themeToggle = document.getElementById('theme-toggle');
const sunIcon = document.getElementById('sun-icon');
const moonIcon = document.getElementById('moon-icon');
const themeLabel = document.getElementById('theme-label');

function initTheme() {
    const isDark = localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) {
        document.documentElement.classList.add('dark');
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
        if (themeLabel) themeLabel.textContent = 'Light Mode';
    } else {
        document.documentElement.classList.remove('dark');
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('hidden');
        if (themeLabel) themeLabel.textContent = 'Dark Mode';
    }
}

themeToggle.onclick = () => {
    if (document.documentElement.classList.contains('dark')) {
        document.documentElement.classList.remove('dark');
        localStorage.setItem('theme', 'light');
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('hidden');
        if (themeLabel) themeLabel.textContent = 'Dark Mode';
    } else {
        document.documentElement.classList.add('dark');
        localStorage.setItem('theme', 'dark');
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
        if (themeLabel) themeLabel.textContent = 'Light Mode';
    }
};

initTheme();

// Tour / Tutorial Logic
const btnTour = document.getElementById('btn-tour');
const driver = window.driver.js.driver;

const driverObj = driver({
    showProgress: true,
    steps: [
        { element: '#display-room-id', popover: { title: 'Room ID', description: 'This is your Room ID. Click it to copy the invite link for your friends.', side: "bottom", align: 'start' }},
        { element: '#menu-toggle', popover: { title: 'Menu', description: 'Access the tutorial, scoreboard, and theme toggle from this menu.', side: "bottom", align: 'end' }},
        { element: '#chat-toggle', popover: { title: 'Chat', description: 'Talk to your friends while playing. You will get notifications for new messages.', side: "bottom", align: 'end' }},
        { element: '#btn-start', popover: { title: 'Start Game', description: 'If you are the host, you can start or restart the game here.', side: "bottom", align: 'end' }},
        { element: '#player-list', popover: { title: 'Players', description: 'See who is currently in the room and how many cards they have.', side: "bottom", align: 'start' }},
        { element: '#table-cards', popover: { title: 'Table Area', description: 'Played cards appear here. Click them to select for taking or discarding.', side: "bottom", align: 'center' }},
        { element: '#my-hand', popover: { title: 'Your Hand', description: 'These are your cards. Click them to select for playing or discarding.', side: "top", align: 'center' }},
        { element: '#btn-play', popover: { title: 'Play Cards', description: 'Play selected cards from your hand to the table.', side: "top", align: 'start' }},
        { element: '#btn-take', popover: { title: 'Take Cards', description: 'Take selected cards from the table to your hand.', side: "top", align: 'center' }},
        { element: '#btn-discard', popover: { title: 'Discard Cards', description: 'Discard selected cards from your hand or the table. They will be removed from the game.', side: "top", align: 'end' }},
        { element: '#btn-quit', popover: { title: 'Leave Room', description: 'Leave the room at any time.', side: "bottom", align: 'end' }},
    ],
    onDeselected: (element) => {
        localStorage.setItem('flip52_tour_seen', 'true');
    },
    onDestroyed: () => {
        localStorage.setItem('flip52_tour_seen', 'true');
    }
});

function startTour() {
    driverObj.drive();
}

btnTour.onclick = startTour;

const suitSymbols = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
const suitOrder = { 'S': 0, 'D': 1, 'C': 2, 'H': 3 };
const rankOrder = { 
    'A': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8, '10': 9, 'J': 10, 'Q': 11, 'K': 12 
};

function sendSocketMessage(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
    } else {
        messageQueue.push(msg);
        if (!socket || (socket && socket.readyState === WebSocket.CLOSED)) {
            connect();
        } else if (!socket) {
            connect();
        }
    }
}

let roomChannel = null;

function handleRoomEvent(data, fromBroadcast = false) {
    if (!fromBroadcast && roomChannel && (data.type === "ROOM_STATE" || data.type === "HAND_UPDATE" || data.type === "CELEBRATE")) {
        roomChannel.postMessage(data);
    }

    if (data.type === "CELEBRATE") {
        if (!window._confettiTimeout) {
            confetti({
                particleCount: 150,
                spread: 70,
                origin: { y: 0.6 },
                zIndex: 9999
            });
            window._confettiTimeout = setTimeout(() => {
                window._confettiTimeout = null;
            }, 1000);
        }
        return;
    }

    if (data.type === "HAND_UPDATE") {
        if (gameState) {
            if (JSON.stringify(gameState.hand) !== JSON.stringify(data.hand)) {
                gameState.hand = data.hand;
                renderHand();
            }
        } else {
            gameState = { hand: data.hand, players: [], table: [], chat: [], scores: {} };
            renderUI();
        }
        return;
    }

    if (data.type === "ROOM_STATE") {
        if (data.roomId && (!roomChannel || roomChannel.name !== `rooms:${data.roomId}`)) {
            if (roomChannel) roomChannel.close();
            roomChannel = new BroadcastChannel(`rooms:${data.roomId}`);
            roomChannel.onmessage = (event) => {
                handleRoomEvent(event.data, true);
            };
        }

        const oldHand = gameState ? gameState.hand : [];
        const isFirstState = !gameState;
        if (gameState) {
            const newMessages = data.chat.slice(lastChatLength);
            newMessages.forEach(msg => {
                if (msg.type === 'activity') {
                    const m = msg.message;
                    if (m.includes(' played ')) sounds.play();
                    else if (m.includes(' took ')) sounds.take();
                    else if (m.includes(' discarded ')) sounds.discard();
                    
                    tickerQueue.push(m);
                    processTicker();
                } else if (msg.name && msg.playerId !== myId) {
                    if (chatPopup.classList.contains('hidden')) {
                        showToast(msg.name, msg.message);
                    }
                }
            });
        }
        lastChatLength = data.chat.length;
        gameState = data;
        if (!gameState.hand) gameState.hand = oldHand;
        if (!myId) myId = data.myId;
        
        const currentHand = new Set(gameState.hand);
        const currentTable = new Set(data.table.map(t => t.cardId));
        selectedHandCards = new Set([...selectedHandCards].filter(id => currentHand.has(id)));
        selectedTableCards = new Set([...selectedTableCards].filter(id => currentTable.has(id)));

        const tableSnapshot = JSON.stringify(gameState.table);
        const tableChanged = tableSnapshot !== prevTableSnapshot;
        prevTableSnapshot = tableSnapshot;

        if (isFirstState) {
            renderUI();
        } else if (tableChanged) {
            renderRoomId();
            renderTable();
            renderPlayerList();
            renderChat();
            updateActionBar();
        } else {
            renderPlayerList();
            renderChat();
            updateActionBar();
        }
        
        const url = new URL(window.location.href);
        if (url.searchParams.get('room') !== data.roomId) {
            url.searchParams.set('room', data.roomId);
            window.history.pushState({}, '', url);
        }

        if (isFirstState && !localStorage.getItem('flip52_tour_seen')) {
            setTimeout(startTour, 1000);
        }
    }
}

function connect(force = false) {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) && !force) {
        return;
    }

    if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
    }

    socket = new WebSocket(wsUrl);

    const connectionTimeout = setTimeout(() => {
        if (socket && socket.readyState === WebSocket.CONNECTING) {
            connect(true);
        }
    }, 5000);

    socket.onopen = () => {
        clearTimeout(connectionTimeout);
        reconnectDelay = 1000;

        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            socket.send(JSON.stringify(msg));
        }

        const roomId = new URLSearchParams(window.location.search).get('room');
        const playerId = localStorage.getItem('flip52_player_id');
        const name = localStorage.getItem('flip52_player_name');
        
        if (roomId && playerId && name && messageQueue.length === 0) {
            socket.send(JSON.stringify({ type: "JOIN_ROOM", name, roomId, playerId }));
            loginOverlay.classList.add('hidden');
        }
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "ERROR") {
            if (data.message !== "Room not found") alert(data.message);
            loginOverlay.classList.remove('hidden');
            return;
        }

        if (data.type === "PLAYER_ID") {
            localStorage.setItem('flip52_player_id', data.playerId);
            myId = data.playerId;
            return;
        }

        handleRoomEvent(data);
    };

    socket.onclose = () => {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    socket.onerror = (err) => {
        console.error("WebSocket error:", err);
    };
}

setTimeout(connect, 100);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            connect();
        }
    }
});

const savedName = localStorage.getItem('flip52_player_name');
if (savedName) playerNameInput.value = savedName;

const urlParams = new URLSearchParams(window.location.search);
const roomParam = urlParams.get('room');
if (roomParam) {
    roomIdInput.value = roomParam.toUpperCase();
}

// Toggle Chat
chatToggle.onclick = () => {
    chatPopup.classList.toggle('hidden');
    if (!chatPopup.classList.contains('hidden')) {
        chatBadge.classList.add('hidden');
        chatMessages.scrollTop = chatMessages.scrollHeight;
        chatInput.focus();
    }
};
chatClose.onclick = () => {
    chatPopup.classList.add('hidden');
};

// Toggle Scoreboard
scoreboardToggle.onclick = () => {
    if (!gameState) return;
    localScores = { ...gameState.scores };
    renderScoreboard();
    scoreboardModal.classList.remove('hidden');
};

scoreboardClose.onclick = () => {
    scoreboardModal.classList.add('hidden');
};

function renderScoreboard() {
    scoreboardList.innerHTML = gameState.players.map(p => {
        const score = localScores[p.id] || 0;
        return `
            <div class="flex items-center justify-between bg-gray-50 dark:bg-gray-800/50 p-3 rounded-xl border border-gray-100 dark:border-gray-700/50">
                <div class="flex flex-col min-w-0">
                    <span class="font-bold text-sm text-gray-800 dark:text-gray-200 truncate">${p.name} ${p.id === myId ? '<span class="text-blue-500 text-xs font-semibold">(You)</span>' : ''}</span>
                    <span class="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Current: ${gameState.scores[p.id] || 0}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <button onclick="updateLocalScore('${p.id}', -1)" class="w-7 h-7 rounded-lg bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 flex items-center justify-center text-gray-500 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 active:scale-90 transition-all font-bold text-sm">−</button>
                    <span class="font-black text-base w-7 text-center text-blue-600 dark:text-blue-400 tabular-nums">${score}</span>
                    <button onclick="updateLocalScore('${p.id}', 1)" class="w-7 h-7 rounded-lg bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 flex items-center justify-center text-gray-500 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 active:scale-90 transition-all font-bold text-sm">+</button>
                </div>
            </div>
        `;
    }).join('');
}

window.updateLocalScore = (playerId, delta) => {
    localScores[playerId] = (localScores[playerId] || 0) + delta;
    renderScoreboard();
};

btnSaveScores.onclick = () => {
    const updates = [];
    Object.entries(localScores).forEach(([playerId, newScore]) => {
        if (newScore !== (gameState.scores[playerId] || 0)) {
            updates.push({ targetPlayerId: playerId, newScore });
        }
    });
    
    if (updates.length > 0) {
        sendSocketMessage({ type: "UPDATE_SCORE", updates });
    }
    
    scoreboardModal.classList.add('hidden');
};

async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.error("Clipboard API failed", err);
        }
    }
    
    try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
    } catch (err) {
        console.error("Fallback copy failed", err);
        return false;
    }
}

// Copy Link on Room ID Click
displayRoomId.onclick = async () => {
    const roomId = displayRoomId.innerText;
    if (roomId === "------" || roomId === "COPIED!") return;

    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    const success = await copyToClipboard(url.toString());
    
    if (success) {
        displayRoomId.innerText = "COPIED!";
        displayRoomId.classList.add('bg-green-100', 'text-green-700', 'dark:bg-green-900/30', 'dark:text-green-400');
        setTimeout(() => {
            displayRoomId.innerText = roomId;
            displayRoomId.classList.remove('bg-green-100', 'text-green-700', 'dark:bg-green-900/30', 'dark:text-green-400');
        }, 1000);
    }
};

// Event Listeners
btnJoin.onclick = () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const name = playerNameInput.value.trim();
    const roomId = roomIdInput.value.trim().toUpperCase();
    if (!name) {
        playerNameInput.focus();
        playerNameInput.classList.add('border-red-300', 'dark:border-red-700');
        setTimeout(() => playerNameInput.classList.remove('border-red-300', 'dark:border-red-700'), 2000);
        return;
    }

    localStorage.setItem('flip52_player_name', name);

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        connect(true);
    }

    if (roomId) {
        sendSocketMessage({ type: "JOIN_ROOM", name, roomId, playerId: localStorage.getItem('flip52_player_id') });
    } else {
        sendSocketMessage({ type: "CREATE_ROOM", name, playerId: localStorage.getItem('flip52_player_id') });
    }
    loginOverlay.classList.add('hidden');
};

btnStart.onclick = () => {
    const action = gameState.state === 'PLAYING' ? "restart" : "start";
    if (action === "restart" && !confirm("This will clear the table and chat. Start a new game?")) return;
    sendSocketMessage({ type: "START_GAME" });
};

btnSend.onclick = sendChat;
chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendChat(); };

function sendChat() {
    const message = chatInput.value.trim();
    if (message) {
        sendSocketMessage({ type: "SEND_CHAT", message });
        chatInput.value = '';
    }
}

btnQuit.onclick = () => {
    if (!confirm("Are you sure you want to quit this room?")) return;
    sendSocketMessage({ type: "LEAVE_ROOM" });
    localStorage.removeItem('flip52_player_id');
    localStorage.removeItem('flip52_player_name');
    gameState = null;
    myId = null;
    lastChatLength = 0;
    loginOverlay.classList.remove('hidden');
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url);
};

btnPlay.onclick = () => {
    if (selectedHandCards.size > 0) {
        sendSocketMessage({ type: "PLAY_CARD", cardIds: Array.from(selectedHandCards) });
        clearSelection();
    }
};

btnTake.onclick = () => {
    if (selectedTableCards.size > 0) {
        sendSocketMessage({ type: "TAKE_CARD", cardIds: Array.from(selectedTableCards) });
        clearSelection();
    }
};

btnDiscard.onclick = () => {
    const cardsToDiscard = [...selectedHandCards, ...selectedTableCards];
    if (cardsToDiscard.length > 0) {
        sendSocketMessage({ type: "DISCARD_CARD", cardIds: cardsToDiscard });
        clearSelection();
    }
};

function formatActivity(message) {
    return message.replace(/\b([AJQK102-9]+)([SHDC])\b/g, (match, rank, suit) => {
        return `<span class="card-tag suit-${suit} font-bold">${rank}${suitSymbols[suit]}</span>`;
    });
}

function sortCards(cards) {
    if (!cards) return [];
    return [...cards].sort((a, b) => {
        const rankA = a.slice(0, -1);
        const suitA = a.slice(-1);
        const rankB = b.slice(0, -1);
        const suitB = b.slice(-1);

        if (suitOrder[suitA] !== suitOrder[suitB]) {
            return suitOrder[suitA] - suitOrder[suitB];
        }
        return rankOrder[rankA] - rankOrder[rankB];
    });
}

function renderRoomId() {
    if (!gameState) return;
    displayRoomId.innerText = gameState.roomId;
}

function renderTable() {
    if (!gameState) return;

    tableCards.innerHTML = '';
    gameState.table.forEach((item, index) => {
        const { cardId, playedBy } = item;
        const cardWrapper = document.createElement('div');
        cardWrapper.className = 'flex flex-col items-center gap-1 card-wrapper';

        const cardEl = createCardElement(cardId);
        if (selectedTableCards.has(cardId)) cardEl.classList.add('selected');

        const playedByEl = document.createElement('div');
        playedByEl.className = 'text-[10px] text-white/60 dark:text-gray-500 font-medium truncate max-w-[60px]';
        playedByEl.innerText = playedBy;

        cardEl.onclick = () => {
            if (selectedTableCards.has(cardId)) {
                selectedTableCards.delete(cardId);
                cardEl.classList.remove('selected');
            } else {
                selectedTableCards.add(cardId);
                cardEl.classList.add('selected');
            }
            updateActionBar();
        };

        cardWrapper.appendChild(cardEl);
        cardWrapper.appendChild(playedByEl);
        tableCards.appendChild(cardWrapper);
    });

    if (gameState.table.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'col-span-full flex flex-col items-center justify-center py-8 text-white/30 dark:text-gray-600';
        emptyState.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="mb-2 opacity-50"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span class="text-xs font-semibold uppercase tracking-widest">Table is empty</span>
        `;
        tableCards.appendChild(emptyState);
    }
}

function createHandCardElement(cardId) {
    const wrapper = document.createElement('div');
    wrapper.className = 'card-wrapper';
    wrapper.dataset.cardId = cardId;

    const cardEl = createCardElement(cardId);
    if (selectedHandCards.has(cardId)) cardEl.classList.add('selected');
    cardEl.onclick = () => {
        if (selectedHandCards.has(cardId)) {
            selectedHandCards.delete(cardId);
            cardEl.classList.remove('selected');
        } else {
            selectedHandCards.add(cardId);
            cardEl.classList.add('selected');
        }
        updateActionBar();
    };
    wrapper.appendChild(cardEl);
    return wrapper;
}

function renderHand() {
    if (!gameState) return;

    const sortedHand = sortCards(gameState.hand);

    // Remove cards no longer in hand
    for (const w of [...myHand.querySelectorAll('.card-wrapper')]) {
        if (!sortedHand.includes(w.dataset.cardId)) {
            w.remove();
        }
    }

    // Add new cards and reposition existing ones
    sortedHand.forEach((cardId, index) => {
        const wrapper = myHand.querySelector(`.card-wrapper[data-card-id="${cardId}"]`);
        const ref = myHand.children[index];

        if (wrapper) {
            // Move to correct position if needed (if it's not already there)
            if (wrapper !== ref) {
                myHand.insertBefore(wrapper, ref);
            }
        } else {
            // Create new card and insert at correct position
            myHand.insertBefore(createHandCardElement(cardId), ref);
        }
    });

    // Manage empty state
    const emptyEl = myHand.querySelector('.empty-hand-state');
    if (gameState.hand.length === 0) {
        if (!emptyEl) {
            const state = document.createElement('div');
            state.className = 'col-span-full flex items-center justify-center py-4 text-gray-400 dark:text-gray-600 empty-hand-state';
            state.innerHTML = `<span class="text-xs font-semibold uppercase tracking-widest">No cards</span>`;
            myHand.appendChild(state);
        }
    } else if (emptyEl) {
        emptyEl.remove();
    }
}

function renderUI() {
    if (!gameState) return;

    renderRoomId();
    if (!gameState.scores) gameState.scores = {};
    renderTable();
    renderHand();
    renderPlayerList();
    renderChat();
    updateActionBar();
}

function renderPlayerList() {
    if (!gameState) return;
    if (!gameState.scores) gameState.scores = {};
    
    if (!scoreboardModal.classList.contains('hidden')) {
        renderScoreboard();
    }
    
    playerList.innerHTML = gameState.players.map(p => `
        <div class="player-chip flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold whitespace-nowrap shadow-sm
            ${p.id === myId ? 'bg-blue-600 text-white border-blue-500' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700'}">
            <span class="relative flex h-2 w-2">
                ${p.online ? '<span class="animate-ping absolute h-full w-full rounded-full bg-green-400 opacity-75"></span><span class="relative rounded-full h-2 w-2 bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.5)]"></span>' : '<span class="rounded-full h-2 w-2 bg-gray-300 dark:bg-gray-600"></span>'}
            </span>
            <span class="max-w-[72px] truncate">${p.name}</span>
            <span class="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold
                ${p.id === myId ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}">
                ${p.handCount}
            </span>
        </div>
    `).join('');

    const startIcon = document.getElementById('start-icon');
    const restartIcon = document.getElementById('restart-icon');

    if (gameState.hostId === myId && gameState.players.length >= 2) {
        btnStart.classList.remove('hidden');
        if (gameState.state === 'PLAYING') {
            startIcon.classList.add('hidden');
            restartIcon.classList.remove('hidden');
            btnStart.title = "Restart Game";
        } else {
            startIcon.classList.remove('hidden');
            restartIcon.classList.add('hidden');
            btnStart.title = "Start Game";
        }
    } else {
        btnStart.classList.add('hidden');
    }
}

function renderChat() {
    const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop <= chatMessages.clientHeight + 10;
    const oldMessageCount = chatMessages.children.length;
    
    const filteredChat = gameState.chat.filter(c => {
        if (c.type !== 'activity') return true;
        const msg = c.message.toLowerCase();
        return !msg.includes('joined the room') && 
               !msg.includes('reconnected') && 
               !msg.includes('disconnected') &&
               !msg.includes('left the room');
    });

    chatMessages.innerHTML = filteredChat.map(c => `
        <div class="leading-snug py-0.5">
            ${c.type === 'activity' 
                ? `<span class="text-[11px] text-gray-400 dark:text-gray-500 italic">${formatActivity(c.message)}</span>`
                : `<span class="text-xs"><span class="font-bold text-blue-500 dark:text-blue-400">${c.name}:</span> <span class="text-gray-700 dark:text-gray-300">${c.message}</span></span>`
            }
        </div>
    `).join('');

    if (gameState.chat.length > oldMessageCount && chatPopup.classList.contains('hidden')) {
        chatBadge.classList.remove('hidden');
    }

    if (wasAtBottom) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

function clearSelection() {
    selectedHandCards.clear();
    selectedTableCards.clear();
    document.querySelectorAll('#my-hand .card.selected, #table-cards .card.selected').forEach(el => el.classList.remove('selected'));
    updateActionBar();
}

function updateActionBar() {
    const totalSelected = selectedHandCards.size + selectedTableCards.size;
    btnPlay.disabled = selectedHandCards.size === 0;
    btnDiscard.disabled = totalSelected === 0;
    btnTake.disabled = selectedTableCards.size === 0;

    document.getElementById('play-count').textContent = selectedHandCards.size > 0 ? selectedHandCards.size : '';
    document.getElementById('discard-count').textContent = totalSelected > 0 ? totalSelected : '';
    document.getElementById('take-count').textContent = selectedTableCards.size > 0 ? selectedTableCards.size : '';
}

function createCardElement(cardId) {
    const rank = cardId.slice(0, -1);
    const suit = cardId.slice(-1);
    const el = document.createElement('div');
    el.className = `card suit-${suit}`;
    el.innerHTML = `
        <span class="card-rank">${rank}</span>
        <span class="card-suit">${suitSymbols[suit]}</span>
    `;
    return el;
}
