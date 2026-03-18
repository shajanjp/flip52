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
        }, 500); // Out duration
    }, 2500); // Visible duration
}

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const chatToggle = document.getElementById('chat-toggle');
const chatPopup = document.getElementById('chat-popup');
const chatClose = document.getElementById('chat-close');
const chatBadge = document.getElementById('chat-badge');

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

function connect(force = false) {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) && !force) {
        return;
    }

    if (socket) {
        console.log("Closing existing socket...");
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
    }

    console.log("Connecting to WebSocket:", wsUrl);
    socket = new WebSocket(wsUrl);

    // Safari iOS fallback: if it stays in CONNECTING too long, something is wrong
    const connectionTimeout = setTimeout(() => {
        if (socket && socket.readyState === WebSocket.CONNECTING) {
            console.warn("Connection timeout, retrying...");
            connect(true);
        }
    }, 5000);

    socket.onopen = () => {
        clearTimeout(connectionTimeout);
        console.log("WebSocket connected");
        reconnectDelay = 1000;

        // Process queued messages
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            socket.send(JSON.stringify(msg));
        }

        // Auto-rejoin if we were in a room
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
            return;
        }

        if (data.type === "ROOM_STATE") {
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
                    }
                });
            }
            lastChatLength = data.chat.length;
            gameState = data;
            myId = data.myId;
            const currentHand = new Set(data.hand);
            const currentTable = new Set(data.table.map(t => t.cardId));
            selectedHandCards = new Set([...selectedHandCards].filter(id => currentHand.has(id)));
            selectedTableCards = new Set([...selectedTableCards].filter(id => currentTable.has(id)));
            renderUI();
            
            const url = new URL(window.location.href);
            if (url.searchParams.get('room') !== data.roomId) {
                url.searchParams.set('room', data.roomId);
                window.history.pushState({}, '', url);
            }
        }
    };

    socket.onclose = () => {
        console.log("WebSocket disconnected, retrying...");
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    socket.onerror = (err) => {
        console.error("WebSocket error:", err);
        console.log("Connection Error to: " + wsUrl + "\n\nPlease check if the server is running and accessible. If using a local IP, ensure your phone is on the same Wi-Fi.");
    };
}

// Initial Connection with small delay for mobile Safari
setTimeout(connect, 100);

// Reconnect when page becomes visible again (helpful for mobile Safari)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            console.log("Visibility changed to visible, reconnecting...");
            connect();
        }
    }
});

// Restore name from localStorage
const savedName = localStorage.getItem('flip52_player_name');
if (savedName) playerNameInput.value = savedName;

// Check URL for Room ID
const urlParams = new URLSearchParams(window.location.search);
const roomParam = urlParams.get('room');
if (roomParam) {
    roomIdInput.value = roomParam.toUpperCase();
}

// Toggle Chat
chatToggle.onclick = () => {
    chatPopup.classList.toggle('hidden');
    if (!chatPopup.classList.contains('hidden')) {
        chatToggle.classList.add('hidden');
        chatBadge.classList.add('hidden');
        chatMessages.scrollTop = chatMessages.scrollHeight;
        chatInput.focus();
    }
};
chatClose.onclick = () => {
    chatPopup.classList.add('hidden');
    chatToggle.classList.remove('hidden');
};

// Helper to copy text to clipboard with fallback
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
        displayRoomId.classList.add('bg-green-200');
        setTimeout(() => {
            displayRoomId.innerText = roomId;
            displayRoomId.classList.remove('bg-green-200');
        }, 1000);
    }
};

// Event Listeners
btnJoin.onclick = () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const name = playerNameInput.value.trim();
    const roomId = roomIdInput.value.trim().toUpperCase();
    if (!name) return alert("Please enter your name");

    localStorage.setItem('flip52_player_name', name);
    const playerId = localStorage.getItem('flip52_player_id');

    // Force connect on user gesture if not already open
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        connect(true);
    }

    const docEl = document.documentElement;
    const requestFs = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
    if (requestFs) {
        requestFs.call(docEl).catch(e => console.warn("Fullscreen failed", e));
    }

    if (roomId) {
        sendSocketMessage({ type: "JOIN_ROOM", name, roomId, playerId });
    } else {
        sendSocketMessage({ type: "CREATE_ROOM", name, playerId });
    }
    loginOverlay.classList.add('hidden');
};

btnStart.onclick = () => {
    const action = gameState.state === 'PLAYING' ? "restart" : "start";
    if (action === "restart" && !confirm("This will clear the table and chat. Start new game?")) return;
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
        selectedHandCards.clear();
        renderUI();
    }
};

btnTake.onclick = () => {
    if (selectedTableCards.size > 0) {
        sendSocketMessage({ type: "TAKE_CARD", cardIds: Array.from(selectedTableCards) });
        selectedTableCards.clear();
        renderUI();
    }
};

btnDiscard.onclick = () => {
    const cardsToDiscard = [...selectedHandCards, ...selectedTableCards];
    if (cardsToDiscard.length > 0) {
        sendSocketMessage({ type: "DISCARD_CARD", cardIds: cardsToDiscard });
        selectedHandCards.clear();
        selectedTableCards.clear();
        renderUI();
    }
};

function formatActivity(message) {
    return message.replace(/\b([AJQK102-9]+)([SHDC])\b/g, (match, rank, suit) => {
        return `<span class="suit-${suit} font-bold">${rank}${suitSymbols[suit]}</span>`;
    });
}

function sortCards(cards) {
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

function renderUI() {
    if (!gameState) return;

    displayRoomId.innerText = gameState.roomId;
    
    playerList.innerHTML = gameState.players.map(p => `
        <div class="flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold whitespace-nowrap shadow-sm
            ${p.id === myId ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-700 border-gray-200'}">
            <div class="w-1.5 h-1.5 rounded-full ${p.online ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.5)]' : 'bg-gray-300'}"></div>
            <span class="max-w-[80px] truncate">${p.name}</span>
            <span class="opacity-70 px-1.5 py-0.5 rounded-full text-[10px] 
                ${p.id === myId ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-500'}">
                ${p.handCount}
            </span>
        </div>
    `).join('');

    if (gameState.hostId === myId && gameState.players.length >= 2) {
        btnStart.classList.remove('hidden');
        btnStart.innerText = gameState.state === 'PLAYING' ? 'RESTART' : 'START';
    } else {
        btnStart.classList.add('hidden');
    }

    tableCards.innerHTML = '';
    gameState.table.forEach((item) => {
        const { cardId, playedBy } = item;
        const cardWrapper = document.createElement('div');
        cardWrapper.className = 'flex flex-col items-center gap-1';
        
        const cardEl = createCardElement(cardId);
        if (selectedTableCards.has(cardId)) cardEl.classList.add('selected');
        
        const playedByEl = document.createElement('div');
        playedByEl.className = 'text-[10px] text-gray-400 font-medium truncate max-w-[60px]';
        playedByEl.innerText = playedBy;
        
        cardEl.onclick = () => {
            if (selectedTableCards.has(cardId)) {
                selectedTableCards.delete(cardId);
            } else {
                selectedTableCards.add(cardId);
            }
            renderUI();
        };
        
        cardWrapper.appendChild(cardEl);
        cardWrapper.appendChild(playedByEl);
        tableCards.appendChild(cardWrapper);
    });

    myHand.innerHTML = '';
    const sortedHand = sortCards(gameState.hand);
    sortedHand.forEach(cardId => {
        const cardEl = createCardElement(cardId);
        if (selectedHandCards.has(cardId)) cardEl.classList.add('selected');
        cardEl.onclick = () => {
            if (selectedHandCards.has(cardId)) {
                selectedHandCards.delete(cardId);
            } else {
                selectedHandCards.add(cardId);
            }
            renderUI();
        };
        myHand.appendChild(cardEl);
    });

    const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop <= chatMessages.clientHeight + 10;
    const oldMessageCount = chatMessages.children.length;
    
    // Filter out connection messages
    const filteredChat = gameState.chat.filter(c => {
        if (c.type !== 'activity') return true;
        const msg = c.message.toLowerCase();
        return !msg.includes('joined the room') && 
               !msg.includes('reconnected') && 
               !msg.includes('disconnected') &&
               !msg.includes('left the room');
    });

    chatMessages.innerHTML = filteredChat.map(c => `
        <div class="mb-1 leading-tight">
            <span class="font-bold ${c.type === 'activity' ? 'text-gray-400 text-xs' : 'text-blue-500'}">${c.type === 'activity' ? 'SYSTEM' : c.name}:</span>
            <span class="${c.type === 'activity' ? 'italic text-gray-500' : 'text-gray-800'}">${c.type === 'activity' ? formatActivity(c.message) : c.message}</span>
        </div>
    `).join('');

    if (gameState.chat.length > oldMessageCount && chatPopup.classList.contains('hidden')) {
        chatBadge.classList.remove('hidden');
    }

    if (wasAtBottom) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    const totalSelected = selectedHandCards.size + selectedTableCards.size;
    btnPlay.disabled = selectedHandCards.size === 0;
    btnDiscard.disabled = totalSelected === 0;
    btnTake.disabled = selectedTableCards.size === 0;

    btnPlay.innerText = `Play (${selectedHandCards.size})`;
    btnDiscard.innerText = `Discard (${totalSelected})`;
    btnTake.innerText = `Take (${selectedTableCards.size})`;
}

function createCardElement(cardId) {
    const rank = cardId.slice(0, -1);
    const suit = cardId.slice(-1);
    const el = document.createElement('div');
    el.className = `card bg-white shadow border suit-${suit}`;
    el.innerHTML = `<div>${rank}</div><div>${suitSymbols[suit]}</div>`;
    return el;
}
