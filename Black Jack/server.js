const net = require('net');
const EventEmitter = require('events');
const os = require('os');

// Get local IP address for LAN connections
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            const { address, family, internal } = iface;
            if (family === 'IPv4' && !internal) {
                return address;
            }
        }
    }
    return '0.0.0.0';
}

// --- Configuration ---
const MAX_BET = 100000;
const START_BALANCE = 100;
const MAX_CHAT_LEN = 500;
const MIN_PLAYERS = 1;
const PORT = 5555;
const HOST = '0.0.0.0';

// --- Helper Functions ---
function calculateHandValue(hand) {
    let value = 0;
    let aces = 0;
    
    for (const card of hand) {
        const v = card.split(' ')[0];
        if (['J', 'Q', 'K'].includes(v)) {
            value += 10;
        } else if (v === 'A') {
            value += 11;
            aces++;
        } else {
            value += parseInt(v);
        }
    }
    
    while (value > 21 && aces > 0) {
        value -= 10;
        aces--;
    }
    
    return value;
}

function createDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const deck = [];
    
    for (const suit of suits) {
        for (const value of values) {
            deck.push(`${value} of ${suit}`);
        }
    }
    
    // Shuffle the deck
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    
    return deck;
}

class Player {
    constructor(nickname, socket) {
        this.nickname = nickname;
        this.socket = socket;
        this.balance = START_BALANCE;
        this.hand = [];
        this.bet = 0;
        this.status = 'waiting';
        this.result = '';
        this.buffer = '';
    }
    
    send(data) {
        if (this.socket && !this.socket.destroyed) {
            try {
                this.socket.write(JSON.stringify(data) + '\n');
                return true;
            } catch (e) {
                console.error(`Error sending to ${this.nickname}:`, e);
                return false;
            }
        }
        return false;
    }
}

class BlackjackServer extends EventEmitter {
    constructor() {
        super();
        this.server = net.createServer(this.handleConnection.bind(this));
        this.players = new Map(); // nickname -> Player
        this.gameState = {
            status: 'waiting',
            currentPlayer: null,
            dealerHand: [],
            revealDealer: false,
            deck: [],
            minPlayers: MIN_PLAYERS
        };
    }
    
    start(port = PORT, host = HOST, callback) {
        this.server.listen(port, host, () => {
            if (callback && typeof callback === 'function') {
                callback();
            }
        });
        
        // Handle errors
        this.server.on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                console.error('\n❌ FEHLER: Port ' + port + ' ist bereits in Benutzung!');
                console.log('Bitte beenden Sie das andere Programm oder wählen Sie einen anderen Port.\n');
                process.exit(1);
            } else {
                console.error('Server error:', e);
            }
        });
        
        return this;
    }
    
    handleConnection(socket) {
        const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
        console.log(`New connection from ${clientAddress}`);
        
        // Set a timeout for nickname input
        const nicknameTimeout = setTimeout(() => {
            if (!socket.destroyed && !this.players.has(socket.nickname)) {
                console.log(`Connection from ${clientAddress} timed out (no nickname received)`);
                socket.end(JSON.stringify({ type: 'error', message: 'Connection timed out' }) + '\n');
            }
        }, 30000); // 30 seconds timeout
        
        // Request nickname
        socket.write(JSON.stringify({ 
            type: 'nick_request',
            message: 'Bitte gib deinen Nickname ein:'
        }) + '\n');
        
        let nicknameReceived = false;
        const onData = (data) => {
            this.buffer += data.toString('utf-8');
            
            while (this.buffer.includes('\n')) {
                const newlineIndex = this.buffer.indexOf('\n');
                const line = this.buffer.substring(0, newlineIndex).trim();
                this.buffer = this.buffer.substring(newlineIndex + 1);
                
                if (!line) continue;
                
                try {
                    // First message is the nickname as plain text
                    if (!nicknameReceived) {
                        const nickname = line;
                        this.handleNickname(socket, nickname);
                        nicknameReceived = true;
                    } else {
                        // Subsequent messages are JSON
                        const msg = JSON.parse(line);
                        this.handleMessage(socket, msg);
                    }
                } catch (e) {
                    console.error('Error processing message:', e);
                    console.error('Line that caused error:', line);
                }
            }
        };
        
        socket.on('data', onData);
        
        socket.on('error', (err) => {
            console.error('Socket error:', err);
            this.removePlayer(socket);
        });
        
        socket.on('close', () => {
            console.log('Client disconnected');
            this.removePlayer(socket);
        });
    }
    
    handleMessage(socket, msg) {
        const type = msg.type;
        
        if (type === 'nickname') {
            this.handleNickname(socket, msg.nickname);
        } else if (type === 'chat') {
            this.handleChat(socket, msg.text);
        } else if (type === 'bet') {
            this.handleBet(socket, msg.amount);
        } else if (type === 'hit') {
            this.handleHit(socket);
        } else if (type === 'stand') {
            this.handleStand(socket);
        } else if (type === 'new_round') {
            this.handleNewRound(socket);
        }
    }
    
    handleNickname(socket, nickname) {
        // Clean up nickname
        nickname = nickname.replace(/[^\w\s-]/g, '').trim().substring(0, 20);
        
        if (!nickname) {
            socket.write(JSON.stringify({ 
                type: 'error', 
                message: 'Ungültiger Nickname. Bitte verwende nur Buchstaben, Zahlen und Leerzeichen.' 
            }) + '\n');
            socket.end();
            return;
        }
        
        if (this.players.has(nickname)) {
            socket.write(JSON.stringify({ 
                type: 'error', 
                message: 'Nickname bereits vergeben. Bitte wähle einen anderen.' 
            }) + '\n');
            socket.end();
            return;
        }
        
        const player = new Player(nickname, socket);
        this.players.set(nickname, player);
        
        console.log(`Player connected: ${nickname}`);
        
        // Send initial state to the new player
        player.send(this.getPublicState());
        this.broadcastState();
        this.tryEnterBetting();
    }
    
    handleChat(socket, text) {
        if (text.length > MAX_CHAT_LEN) {
            return;
        }
        
        const player = this.findPlayerBySocket(socket);
        if (!player) return;
        
        const chatMsg = {
            type: 'chat',
            from: player.nickname,
            text: text,
            ts: Math.floor(Date.now() / 1000)
        };
        
        this.broadcast(chatMsg);
    }
    
    handleBet(socket, amount) {
        const player = this.findPlayerBySocket(socket);
        if (!player || this.gameState.status !== 'betting') return;
        
        amount = parseInt(amount);
        if (isNaN(amount) || amount <= 0 || amount > player.balance || amount > MAX_BET) {
            return;
        }
        
        player.bet = amount;
        player.status = 'ready';
        
        this.broadcastState();
        this.tryStartRound();
    }
    
    handleHit(socket) {
        const player = this.findPlayerBySocket(socket);
        if (!player || this.gameState.status !== 'playing' || this.gameState.currentPlayer !== player.nickname) {
            return;
        }
        
        // Draw card
        const card = this.drawCard();
        player.hand.push(card);
        
        // Check for bust
        const value = calculateHandValue(player.hand);
        if (value > 21) {
            player.status = 'bust';
            player.result = 'Bust!';
            player.balance -= player.bet;
            this.nextPlayer();
        }
        
        this.broadcastState();
    }
    
    handleStand(socket) {
        const player = this.findPlayerBySocket(socket);
        if (!player || this.gameState.status !== 'playing' || this.gameState.currentPlayer !== player.nickname) {
            return;
        }
        
        player.status = 'stand';
        this.nextPlayer();
    }
    
    handleNewRound(socket) {
        const player = this.findPlayerBySocket(socket);
        if (!player || this.gameState.status !== 'ended') return;
        
        player.status = 'waiting';
        player.hand = [];
        player.bet = 0;
        player.result = '';
        
        // If all players are ready, start new betting round
        const allWaiting = Array.from(this.players.values()).every(p => 
            p.status === 'waiting' || p.status === 'ready'
        );
        
        if (allWaiting) {
            this.gameState.status = 'betting';
            this.gameState.dealerHand = [];
            this.gameState.revealDealer = false;
            this.gameState.currentPlayer = null;
        }
        
        this.broadcastState();
    }
    
    // --- Game Logic ---
    
    tryEnterBetting() {
        if (this.gameState.status === 'waiting' && this.players.size >= this.gameState.minPlayers) {
            this.gameState.status = 'betting';
            this.broadcastState();
        }
    }
    
    tryStartRound() {
        const activePlayers = Array.from(this.players.values()).filter(p => 
            ['waiting', 'betting', 'ready'].includes(p.status) && p.bet > 0
        );
        
        if (activePlayers.length === 0 || !activePlayers.every(p => p.bet > 0)) {
            return;
        }
        
        // Initialize game state
        this.gameState.status = 'playing';
        this.gameState.deck = createDeck();
        this.gameState.dealerHand = [this.drawCard(), this.drawCard()];
        this.gameState.revealDealer = false;
        
        // Deal cards to players
        for (const player of activePlayers) {
            player.hand = [this.drawCard(), this.drawCard()];
            player.status = 'playing';
            player.result = '';
        }
        
        // Set first player
        this.gameState.currentPlayer = activePlayers[0].nickname;
        
        this.broadcastState();
    }
    
    nextPlayer() {
        const playing = Array.from(this.players.values())
            .filter(p => p.status === 'playing')
            .map(p => p.nickname);
        
        if (playing.length === 0) {
            this.gameState.status = 'dealer_turn';
            this.gameState.revealDealer = true;
            this.dealerPlay();
        } else {
            const currIdx = playing.indexOf(this.gameState.currentPlayer);
            const nextIdx = (currIdx + 1) % playing.length;
            this.gameState.currentPlayer = playing[nextIdx];
        }
        
        this.broadcastState();
    }
    
    async dealerPlay() {
        while (calculateHandValue(this.gameState.dealerHand) < 17) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            this.gameState.dealerHand.push(this.drawCard());
            this.broadcastState();
        }
        
        this.determineWinners();
    }
    
    determineWinners() {
        const dealerValue = calculateHandValue(this.gameState.dealerHand);
        const dealerBust = dealerValue > 21;
        
        for (const player of this.players.values()) {
            if (player.status !== 'bust' && player.status !== 'stand') continue;
            
            const playerValue = calculateHandValue(player.hand);
            
            if (dealerBust || playerValue > dealerValue) {
                player.result = 'Gewonnen!';
                player.balance += player.bet * 2; // Win double the bet
            } else if (playerValue === dealerValue) {
                player.result = 'Unentschieden';
                player.balance += player.bet; // Return bet
            } else {
                player.result = 'Verloren';
                // Bet is already subtracted on bust
                if (player.status !== 'bust') {
                    player.balance -= player.bet;
                }
            }
        }
        
        this.gameState.status = 'ended';
        this.broadcastState();
    }
    
    drawCard() {
        if (this.gameState.deck.length === 0) {
            this.gameState.deck = createDeck();
        }
        return this.gameState.deck.pop();
    }
    
    // --- Helper Methods ---
    
    findPlayerBySocket(socket) {
        return Array.from(this.players.values()).find(p => p.socket === socket);
    }
    
    getPublicState() {
        const publicDealer = !this.gameState.revealDealer && this.gameState.dealerHand.length > 0
            ? ['[verdeckt]', ...this.gameState.dealerHand.slice(1)]
            : [...this.gameState.dealerHand];
        
        const dealerValue = this.gameState.revealDealer 
            ? calculateHandValue(this.gameState.dealerHand)
            : null;
        
        const playersState = {};
        const playerList = [];
        
        for (const [nickname, player] of this.players.entries()) {
            const playerState = {
                hand: player.hand,
                hand_value: calculateHandValue(player.hand),
                bet: player.bet,
                balance: player.balance,
                status: player.status,
                result: player.status === 'playing' ? '' : player.result,
                is_current: this.gameState.currentPlayer === nickname
            };
            
            playersState[nickname] = playerState;
            playerList.push({
                nickname,
                ...playerState
            });
        }
        
        // Sort players by join order (or any other logic you prefer)
        playerList.sort((a, b) => a.nickname.localeCompare(b.nickname));
        
        return {
            type: 'state',
            timestamp: Date.now(),
            server_time: new Date().toISOString(),
            rules: {
                max_bet: MAX_BET,
                start_balance: START_BALANCE,
                min_players: this.gameState.minPlayers
            },
            players: playersState,
            player_list: playerList,
            game_state: {
                status: this.gameState.status,
                status_message: this.getStatusMessage(),
                current_player: this.gameState.currentPlayer,
                dealer_hand: publicDealer,
                dealer_value: dealerValue,
                player_count: this.players.size
            },
            stats: {
                active_players: Object.values(playersState).filter(p => 
                    ['playing', 'betting', 'ready'].includes(p.status)
                ).length,
                total_players: this.players.size
            }
        };
    }
    
    getStatusMessage() {
        switch (this.gameState.status) {
            case 'waiting':
                return `Warte auf Spieler (${this.players.size}/${this.gameState.minPlayers} benötigt)`;
            case 'betting':
                return 'Einsatzphase - Bitte setzen';
            case 'playing':
                return `Dran: ${this.gameState.currentPlayer}`;
            case 'dealer_turn':
                return 'Dealer ist an der Reihe...';
            case 'ended':
                return 'Runde beendet';
            default:
                return '';
        }
    }
    
    broadcastState() {
        const state = this.getPublicState();
        this.broadcast(state);
    }
    
    broadcast(msg, excludeSocket = null) {
        const data = JSON.stringify(msg) + '\n';
        const excludeNickname = excludeSocket?.nickname;
        
        for (const [nickname, player] of this.players.entries()) {
            if (nickname !== excludeNickname && !player.socket.destroyed) {
                try {
                    player.socket.write(data, 'utf8');
                } catch (e) {
                    console.error(`Error broadcasting to ${player.nickname}:`, e);
                    this.removePlayer(player.socket);
                }
            }
        }
    }
    
    removePlayer(socket) {
        const player = this.findPlayerBySocket(socket);
        if (!player) return;
        
        const wasInGame = ['playing', 'betting', 'ready'].includes(player.status);
        const nickname = player.nickname;
        
        console.log(`Player disconnected: ${nickname}`);
        this.players.delete(nickname);
        
        // Handle player leaving during game
        if (wasInGame) {
            // If it's the current player's turn, move to next player
            if (this.gameState.currentPlayer === nickname) {
                this.nextPlayer();
            }
            
            // Check if game should end due to not enough players
            const activePlayers = Array.from(this.players.values())
                .filter(p => ['playing', 'betting', 'ready'].includes(p.status));
                
            if (activePlayers.length < this.gameState.minPlayers) {
                this.endGame('Zu wenige Spieler. Das Spiel wurde beendet.');
            }
        }
        
        // Notify other players
        this.broadcast({
            type: 'player_left',
            nickname: nickname,
            message: `${nickname} hat das Spiel verlassen`
        });
        
        this.broadcastState();
    }
}

// Start the server
const server = new BlackjackServer();

// Function to display connection information
function displayConnectionInfo(port) {
    const interfaces = os.networkInterfaces();
    const localIp = '127.0.0.1';
    
    console.log('\n' + '='.repeat(50));
    console.log('  🃏  BLACKJACK SERFER GESTARTET  🃏');
    console.log('='.repeat(50));
    
    console.log('\n🔹 LOKALER ZUGRIFF:');
    console.log(`   http://localhost:${port}`);
    
    console.log('\n🔹 NETZWERK-ZUGRIFF (andere Geräte im gleichen WLAN):');
    
    // Display all active network interfaces
    let foundAddress = false;
    Object.keys(interfaces).forEach(iface => {
        interfaces[iface].forEach(details => {
            // Check for IPv4 and non-internal addresses
            if (details.family === 'IPv4' && !details.internal) {
                console.log(`   http://${details.address}:${port}  (${iface})`);
                foundAddress = true;
            }
        });
    });
    
    if (!foundAddress) {
        console.log('   Keine Netzwerkverbindung gefunden!');
    }
    
    console.log('\n🔹 SO VERBINDEN SICH ANDERE SPIELER:');
    console.log('   1. Auf dem gleichen WLAN-Netzwerk anmelden');
    console.log('   2. Im Client die oben angezeigte IP-Adresse eingeben');
    console.log('   3. Einen einzigartigen Benutzernamen wählen');
    console.log('\n' + '='.repeat(50));
    console.log('   Warte auf Spieler... (Drücke STRG+C zum Beenden)');
    console.log('='.repeat(50) + '\n');
}

// Start the server
server.start(PORT, HOST, () => {
    displayConnectionInfo(PORT);
});

// Handle process termination
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    // Notify all players
    for (const player of server.players.values()) {
        try {
            player.send({ type: 'server_message', message: 'Server is shutting down. Goodbye!' });
            player.socket.end();
        } catch (e) {
            console.error('Error disconnecting player:', e);
        }
    }
    process.exit();
});
