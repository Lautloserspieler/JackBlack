import socket
import threading
import random
import time
import json

# --- Konfiguration -----------------------------------------------------------
MAX_BET = 100_000      # hartes Einsatz-Limit
START_BALANCE = 100    # Startguthaben pro Spieler
MAX_CHAT_LEN = 500     # Zeichenlimit pro Chatnachricht

# --- Hilfsfunktionen ---------------------------------------------------------

def json_send(sock, obj):
    data = (json.dumps(obj) + "\n").encode("utf-8")
    sock.sendall(data)

def json_recv_lines(sock, buf):
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            return False
        buf["data"] += chunk.decode("utf-8")
        while "\n" in buf["data"]:
            line, buf["data"] = buf["data"].split("\n", 1)
            line = line.strip()
            if line:
                yield json.loads(line)

# --- Blackjack-Server --------------------------------------------------------

class BlackjackServer:
    def __init__(self, host='0.0.0.0', port=5555, min_players=1):
        self.host = host
        self.port = port
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind((host, port))
        self.server.listen()

        self.clients = []
        self.nick_by_client = {}
        self.client_by_nick = {}

        self.players = {}       # nickname -> dict(hand, bet, balance, status, result)
        self.min_players = min_players

        self.lock = threading.Lock()

        self.game_state = {
            'status': 'waiting',           # waiting, betting, playing, dealer_turn, ended
            'current_player': None,
            'dealer_hand': [],
            'reveal_dealer': False,
            'deck': []
        }

    # ---------------- State & Broadcast ----------------

    def make_public_state(self):
        with self.lock:
            if not self.game_state['reveal_dealer'] and self.game_state['dealer_hand']:
                public_dealer = ["[verdeckt]"] + self.game_state['dealer_hand'][1:]
            else:
                public_dealer = list(self.game_state['dealer_hand'])

            payload = {
                'type': 'state',
                'rules': {
                    'max_bet': MAX_BET,
                    'start_balance': START_BALANCE
                },
                'players': self.players,
                'game_state': {
                    'status': self.game_state['status'],
                    'current_player': self.game_state['current_player'],
                    'dealer_hand': public_dealer
                }
            }
            return payload

    def broadcast_state(self):
        self.broadcast(self.make_public_state())

    def send_state_to(self, client):
        self.safe_send(client, self.make_public_state())

    def broadcast_info(self, text):
        self.broadcast({'type': 'info', 'message': text})

    def broadcast_chat(self, sender, text):
        msg = {'type': 'chat', 'from': sender, 'text': text, 'ts': int(time.time())}
        self.broadcast(msg)

    def broadcast(self, obj, exclude=None):
        dead = []
        with self.lock:
            for c in self.clients:
                if exclude and c is exclude:
                    continue
                if not self.safe_send(c, obj):
                    dead.append(c)
        for c in dead:
            self.remove_client(c)

    def safe_send(self, client, obj):
        try:
            json_send(client, obj)
            return True
        except Exception:
            return False

    # ---------------- Karten/Regeln --------------------

    def create_deck(self):
        suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades']
        values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
        deck = [f'{v} of {s}' for s in suits for v in values]
        random.shuffle(deck)
        return deck

    def draw_card(self):
        if not self.game_state['deck']:
            self.game_state['deck'] = self.create_deck()
        return self.game_state['deck'].pop()

    @staticmethod
    def calculate_hand_value(hand):
        value = 0
        aces = 0
        for card in hand:
            v = card.split()[0]
            if v in ['J', 'Q', 'K']:
                value += 10
            elif v == 'A':
                value += 11
                aces += 1
            else:
                value += int(v)
        while value > 21 and aces > 0:
            value -= 10
            aces -= 1
        return value

    # ---------------- Spiel-Flow -----------------------

    def try_enter_betting(self):
        with self.lock:
            if self.game_state['status'] == 'waiting' and len(self.players) >= self.min_players:
                self.game_state['status'] = 'betting'
        self.broadcast_state()

    def start_round(self):
        with self.lock:
            active = [n for n, p in self.players.items() if p['status'] in ('waiting', 'betting', 'ready')]
            if not active or not all(self.players[n]['bet'] > 0 for n in active):
                return

            self.game_state['status'] = 'playing'
            self.game_state['deck'] = self.create_deck()
            self.game_state['dealer_hand'] = [self.draw_card(), self.draw_card()]
            self.game_state['reveal_dealer'] = False

            for n in active:
                self.players[n]['hand'] = [self.draw_card(), self.draw_card()]
                self.players[n]['status'] = 'playing'
                self.players[n]['result'] = ''

            self.game_state['current_player'] = active[0]

        self.broadcast_state()

    def next_player(self):
        with self.lock:
            playing = [n for n, p in self.players.items() if p['status'] == 'playing']
            if not playing:
                self.game_state['status'] = 'dealer_turn'
                self.game_state['reveal_dealer'] = True
                state = self.make_public_state()
            else:
                curr = self.game_state['current_player']
                idx = playing.index(curr) if curr in playing else -1
                self.game_state['current_player'] = playing[(idx + 1) % len(playing)]
                state = self.make_public_state()
        self.broadcast(state)
        if state['game_state']['status'] == 'dealer_turn':
            self.dealer_play()

    def dealer_play(self):
        while True:
            with self.lock:
                val = self.calculate_hand_value(self.game_state['dealer_hand'])
                if val >= 17:
                    break
                self.game_state['dealer_hand'].append(self.draw_card())
                snap = self.make_public_state()
            self.broadcast(snap)
            time.sleep(1)

        self.determine_winners()
        with self.lock:
            self.game_state['status'] = 'ended'
            self.game_state['current_player'] = None
        self.broadcast_state()

    def determine_winners(self):
        with self.lock:
            dealer_value = self.calculate_hand_value(self.game_state['dealer_hand'])
            for n, p in self.players.items():
                if p['bet'] <= 0:
                    continue
                player_value = self.calculate_hand_value(p['hand'])
                if p['status'] == 'busted':
                    p['result'] = 'lose'
                elif dealer_value > 21 or player_value > dealer_value:
                    p['balance'] += p['bet'] * 2
                    p['result'] = 'win'
                elif player_value == dealer_value:
                    p['balance'] += p['bet']
                    p['result'] = 'push'
                else:
                    p['result'] = 'lose'

    def reset_for_next_round(self):
        with self.lock:
            for p in self.players.values():
                p['hand'] = []
                p['bet'] = 0
                p['status'] = 'waiting'
                p['result'] = ''
            self.game_state.update({
                'status': 'betting' if len(self.players) >= self.min_players else 'waiting',
                'current_player': None,
                'dealer_hand': [],
                'reveal_dealer': False,
                'deck': []
            })
        self.broadcast_state()

    # ---------------- Nachrichten ---------------------

    def process(self, client, msg):
        t = msg.get('type')

        if t == 'join':
            nickname = msg.get('nickname')
            if not nickname:
                return
            with self.lock:
                self.nick_by_client[client] = nickname
                self.client_by_nick[nickname] = client
                if nickname not in self.players:
                    self.players[nickname] = {
                        'hand': [],
                        'bet': 0,
                        'balance': START_BALANCE,
                        'status': 'waiting',  # waiting, betting, playing, stood, busted
                        'result': ''
                    }
                if self.game_state['status'] == 'waiting' and len(self.players) >= self.min_players:
                    self.game_state['status'] = 'betting'
            self.broadcast_info(f"{nickname} ist dem Spiel beigetreten.")
            self.broadcast_state()

        elif t == 'bet':
            nickname = msg.get('nickname')
            try:
                bet = int(msg.get('bet', 0))
            except Exception:
                self.safe_send(client, {'type': 'error', 'message': 'Ungültiger Einsatz'})
                return

            with self.lock:
                p = self.players.get(nickname)
                if not p:
                    return
                if bet <= 0:
                    self.safe_send(client, {'type': 'error', 'message': 'Einsatz muss > 0 sein'})
                    return
                if bet > MAX_BET:
                    self.safe_send(client, {'type': 'error', 'message': f'Max. Einsatz ist {MAX_BET}.'})
                    return
                if bet > p['balance']:
                    self.safe_send(client, {'type': 'error', 'message': 'Nicht genug Guthaben'})
                    return

                p['bet'] = bet
                p['balance'] -= bet
                p['status'] = 'ready'

            self.broadcast_state()
            self.start_round()

        elif t == 'hit':
            nickname = msg.get('nickname')
            with self.lock:
                if self.game_state['current_player'] != nickname or self.game_state['status'] != 'playing':
                    return
                self.players[nickname]['hand'].append(self.draw_card())
                if self.calculate_hand_value(self.players[nickname]['hand']) > 21:
                    self.players[nickname]['status'] = 'busted'
            self.broadcast_state()
            with self.lock:
                busted_now = self.players[nickname]['status'] == 'busted'
            if busted_now:
                self.next_player()

        elif t == 'stand':
            nickname = msg.get('nickname')
            with self.lock:
                if self.game_state['current_player'] != nickname or self.game_state['status'] != 'playing':
                    return
                self.players[nickname]['status'] = 'stood'
            self.broadcast_state()
            self.next_player()

        elif t == 'new_round':
            with self.lock:
                if self.game_state['status'] != 'ended':
                    return
            self.reset_for_next_round()

        elif t == 'chat':
            # Chatnachricht verteilen (mit Längenlimit)
            nickname = self.nick_by_client.get(client)
            if not nickname:
                return
            text = (msg.get('text') or "").strip()
            if not text:
                return
            if len(text) > MAX_CHAT_LEN:
                text = text[:MAX_CHAT_LEN]
            self.broadcast_chat(nickname, text)

        elif t == 'leave':
            self.remove_client(client)

    # ---------------- Verbindungen --------------------

    def handle_client(self, client):
        buf = {"data": ""}
        try:
            json_send(client, {'type': 'nick_request'})
            raw = client.recv(4096)
            nick = raw.decode('utf-8').strip()
            if not nick:
                client.close()
                return
        except Exception:
            client.close()
            return

        with self.lock:
            self.clients.append(client)
            self.nick_by_client[client] = nick
            self.client_by_nick[nick] = client

        self.try_enter_betting()
        self.send_state_to(client)

        try:
            for msg in json_recv_lines(client, buf):
                self.process(client, msg)
        except Exception:
            pass
        finally:
            self.remove_client(client)

    def remove_client(self, client):
        with self.lock:
            nickname = self.nick_by_client.pop(client, None)
            if client in self.clients:
                self.clients.remove(client)
            if nickname and nickname in self.client_by_nick:
                self.client_by_nick.pop(nickname, None)
            if nickname and nickname in self.players:
                self.players[nickname]['status'] = 'waiting'
                self.players[nickname]['hand'] = []
                self.players[nickname]['bet'] = 0
                self.players[nickname]['result'] = ''
        try:
            client.close()
        except Exception:
            pass
        if nickname:
            self.broadcast_info(f"{nickname} hat das Spiel verlassen.")
            self.broadcast_state()

    def start(self):
        print(f"Server läuft auf {self.host}:{self.port}")
        while True:
            client, addr = self.server.accept()
            print(f"Verbunden mit {addr}")
            threading.Thread(target=self.handle_client, args=(client,), daemon=True).start()

if __name__ == "__main__":
    BlackjackServer().start()
