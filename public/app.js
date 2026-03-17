const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

let myId = null;
let selectedHandCards = new Set();
let selectedTableCards = new Set();
let gameState = null;

const suitSymbols = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
const suitOrder = { 'S': 0, 'H': 1, 'C': 2, 'D': 3 };
const rankOrder = { 
    'A': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8, '10': 9, 'J': 10, 'Q': 11, 'K': 12 
};

// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const playerNameInput = document.getElementById('player-name');
const roomIdInput = document.getElementById('room-id');
const btnJoin = document.getElementById('btn-join');

const displayRoomId = document.getElementById('display-room-id');
const playerList = document.getElementById('player-list');
const btnStart = document.getElementById('btn-start');

const tableCards = document.getElementById('table-cards');
const myHand = document.getElementById('my-hand');

const btnPlay = document.getElementById('btn-play');
const btnTake = document.getElementById('btn-take');
const btnDiscard = document.getElementById('btn-discard');

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const chatToggle = document.getElementById('chat-toggle');
const chatPopup = document.getElementById('chat-popup');
const chatClose = document.getElementById('chat-close');
const chatBadge = document.getElementById('chat-badge');

// Toggle Chat
chatToggle.onclick = () => {
    chatPopup.classList.toggle('hidden');
    if (!chatPopup.classList.contains('hidden')) {
        chatBadge.classList.add('hidden');
        chatMessages.scrollTop = chatMessages.scrollHeight;
        chatInput.focus();
    }
};
chatClose.onclick = () => chatPopup.classList.add('hidden');

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
    
    // Fallback for insecure contexts
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

// Check URL for Room ID
const urlParams = new URLSearchParams(window.location.search);
const roomParam = urlParams.get('room');
if (roomParam) {
    roomIdInput.value = roomParam.toUpperCase();
}

// Event Listeners
btnJoin.onclick = () => {
    const name = playerNameInput.value.trim();
    const roomId = roomIdInput.value.trim().toUpperCase();
    if (!name) return alert("Please enter your name");

    // Request fullscreen on user gesture (with vendor prefixes)
    const docEl = document.documentElement;
    const requestFs = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
    if (requestFs) {
        requestFs.call(docEl).catch(e => console.warn("Fullscreen failed", e));
    }

    if (roomId) {
        socket.send(JSON.stringify({ type: "JOIN_ROOM", name, roomId }));
    } else {
        socket.send(JSON.stringify({ type: "CREATE_ROOM", name }));
    }
    loginOverlay.classList.add('hidden');
};

btnStart.onclick = () => {
    const action = gameState.state === 'PLAYING' ? "restart" : "start";
    if (action === "restart" && !confirm("This will clear the table and chat. Start new game?")) return;
    socket.send(JSON.stringify({ type: "START_GAME" }));
};

btnSend.onclick = sendChat;
chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendChat(); };

function sendChat() {
    const message = chatInput.value.trim();
    if (message) {
        socket.send(JSON.stringify({ type: "SEND_CHAT", message }));
        chatInput.value = '';
    }
}

btnPlay.onclick = () => {
    if (selectedHandCards.size > 0) {
        socket.send(JSON.stringify({ type: "PLAY_CARD", cardIds: Array.from(selectedHandCards) }));
        selectedHandCards.clear();
        renderUI();
    }
};

btnTake.onclick = () => {
    if (selectedTableCards.size > 0) {
        socket.send(JSON.stringify({ type: "TAKE_CARD", cardIds: Array.from(selectedTableCards) }));
        selectedTableCards.clear();
        renderUI();
    }
};

btnDiscard.onclick = () => {
    const cardsToDiscard = [...selectedHandCards, ...selectedTableCards];
    if (cardsToDiscard.length > 0) {
        socket.send(JSON.stringify({ type: "DISCARD_CARD", cardIds: cardsToDiscard }));
        selectedHandCards.clear();
        selectedTableCards.clear();
        renderUI();
    }
};

// WebSocket Handlers
socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "ERROR") {
        alert(data.message);
        loginOverlay.classList.remove('hidden');
        return;
    }

    if (data.type === "ROOM_STATE") {
        gameState = data;
        myId = data.myId;
        // Keep selection of cards that are still in hand/table
        const currentHand = new Set(data.hand);
        const currentTable = new Set(data.table);
        selectedHandCards = new Set([...selectedHandCards].filter(id => currentHand.has(id)));
        selectedTableCards = new Set([...selectedTableCards].filter(id => currentTable.has(id)));
        renderUI();
        
        // Update URL without reloading
        const url = new URL(window.location.href);
        if (url.searchParams.get('room') !== data.roomId) {
            url.searchParams.set('room', data.roomId);
            window.history.pushState({}, '', url);
        }
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
    
    // Players List
    playerList.innerHTML = gameState.players.map(p => `
        <span class="${p.id === myId ? 'font-bold text-blue-600' : ''}">
            ${p.name} (${p.handCount})
        </span>
    `).join(' • ');

    // Start/New Game Button Visibility
    if (gameState.hostId === myId && gameState.players.length >= 2) {
        btnStart.classList.remove('hidden');
        btnStart.innerText = gameState.state === 'PLAYING' ? 'New Game' : 'Start Game';
    } else {
        btnStart.classList.add('hidden');
    }

    // Table Cards
    tableCards.innerHTML = '';
    gameState.table.forEach((cardId, index) => {
        const cardEl = createCardElement(cardId);
        if (selectedTableCards.has(cardId)) cardEl.classList.add('selected');
        cardEl.onclick = () => {
            if (selectedTableCards.has(cardId)) {
                selectedTableCards.delete(cardId);
            } else {
                selectedTableCards.add(cardId);
            }
            renderUI();
        };
        tableCards.appendChild(cardEl);
    });

    // My Hand - SORTED
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

    // Chat
    const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop <= chatMessages.clientHeight + 10;
    const oldMessageCount = chatMessages.children.length;
    
    chatMessages.innerHTML = gameState.chat.map(c => `
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

    // Action Buttons State
    const totalSelected = selectedHandCards.size + selectedTableCards.size;
    btnPlay.disabled = selectedHandCards.size === 0;
    btnDiscard.disabled = totalSelected === 0;
    btnTake.disabled = selectedTableCards.size === 0;

    // Update button text to show count
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
