import socket
import threading
import json
import time
import tkinter as tk
from tkinter import messagebox, simpledialog

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

class BlackjackClient:
    def __init__(self):
        self.client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.nickname = None
        self.game_state = {}
        self.connected = False
        self.max_bet = 100_000  # wird aus Server-State gelesen

        self.setup_gui()

    # ---------------- GUI -----------------------------------------------------

    def setup_gui(self):
        self.window = tk.Tk()
        self.window.title("Blackjack")
        self.window.geometry("1100x720")

        # Verbindung
        top = tk.Frame(self.window)
        top.pack(pady=10, fill=tk.X)

        tk.Label(top, text="Server:").grid(row=0, column=0, sticky="w")
        self.server_entry = tk.Entry(top, width=18)
        self.server_entry.insert(0, "localhost")
        self.server_entry.grid(row=0, column=1, padx=5)

        tk.Label(top, text="Port:").grid(row=0, column=2, sticky="w")
        self.port_entry = tk.Entry(top, width=6)
        self.port_entry.insert(0, "5555")
        self.port_entry.grid(row=0, column=3, padx=5)

        self.connect_btn = tk.Button(top, text="Verbinden", command=self.connect)
        self.connect_btn.grid(row=0, column=4, padx=10)

        self.status_lbl = tk.Label(self.window, text="Nicht verbunden")
        self.status_lbl.pack()

        # Info
        info = tk.Frame(self.window)
        info.pack(pady=5)
        self.balance_lbl = tk.Label(info, text="Balance: -")
        self.balance_lbl.pack()
        self.rules_lbl = tk.Label(info, text="Regeln: Max Bet 100000 | Start 100")
        self.rules_lbl.pack()

        # Hauptbereich (links Spiel, rechts Chat)
        main = tk.Frame(self.window)
        main.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        # Spielfläche links
        left = tk.Frame(main)
        left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.game_frame = tk.Frame(left)
        self.game_frame.pack(pady=10, fill=tk.X)

        # Dealer
        self.dealer_frame = tk.LabelFrame(self.game_frame, text="Dealer", padx=10, pady=10)
        self.dealer_frame.grid(row=0, column=0, padx=20, pady=10, sticky="w")
        self.dealer_hand_lbl = tk.Label(self.dealer_frame, text="Karten: ")
        self.dealer_hand_lbl.pack(anchor="w")
        self.dealer_value_lbl = tk.Label(self.dealer_frame, text="Wert: ?")
        self.dealer_value_lbl.pack(anchor="w")

        # Eigenes
        self.player_frame = tk.LabelFrame(self.game_frame, text="Du", padx=10, pady=10)
        self.player_frame.grid(row=1, column=0, padx=20, pady=10, sticky="w")
        self.hand_lbl = tk.Label(self.player_frame, text="Karten: ")
        self.hand_lbl.pack(anchor="w")
        self.value_lbl = tk.Label(self.player_frame, text="Wert: -")
        self.value_lbl.pack(anchor="w")

        # Aktionen
        self.action_frame = tk.Frame(left)
        self.action_frame.pack(pady=10, fill=tk.X)

        self.bet_btn = tk.Button(self.action_frame, text="Einsatz setzen", command=self.place_bet, state=tk.DISABLED)
        self.bet_btn.pack(side=tk.LEFT, padx=5)
        self.hit_btn = tk.Button(self.action_frame, text="Hit", command=self.hit, state=tk.DISABLED)
        self.hit_btn.pack(side=tk.LEFT, padx=5)
        self.stand_btn = tk.Button(self.action_frame, text="Stand", command=self.stand, state=tk.DISABLED)
        self.stand_btn.pack(side=tk.LEFT, padx=5)
        self.new_round_btn = tk.Button(self.action_frame, text="Neue Runde", command=self.new_round, state=tk.DISABLED)
        self.new_round_btn.pack(side=tk.LEFT, padx=5)

        # Andere Spieler
        self.others_frame = tk.LabelFrame(left, text="Andere Spieler")
        self.others_frame.pack(fill=tk.BOTH, expand=True, padx=0, pady=10)
        self.others_txt = tk.Text(self.others_frame, height=10, state=tk.DISABLED)
        self.others_txt.pack(fill=tk.BOTH, expand=True)

        # Chat rechts
        right = tk.Frame(main)
        right.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)

        self.chat_frame = tk.LabelFrame(right, text="Chat")
        self.chat_frame.pack(fill=tk.BOTH, expand=True)

        self.chat_txt = tk.Text(self.chat_frame, state=tk.DISABLED, wrap=tk.WORD)
        self.chat_txt.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        input_row = tk.Frame(self.chat_frame)
        input_row.pack(fill=tk.X, padx=8, pady=(0,8))
        self.chat_entry = tk.Entry(input_row)
        self.chat_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.chat_send_btn = tk.Button(input_row, text="Senden", command=self.send_chat)
        self.chat_send_btn.pack(side=tk.LEFT, padx=6)

        # Enter sendet
        self.chat_entry.bind("<Return>", lambda e: (self.send_chat(), "break"))

        # Log/Infos unten (optional, kann für Systemmeldungen genutzt werden)
        self.log_frame = tk.LabelFrame(self.window, text="Nachrichten (System)")
        self.log_frame.pack(fill=tk.BOTH, expand=False, padx=10, pady=5)
        self.log_txt = tk.Text(self.log_frame, height=5, state=tk.DISABLED)
        self.log_txt.pack(fill=tk.BOTH, expand=True)

    # ---------------- Netzwerk ------------------------------------------------

    def connect(self):
        try:
            self.client.connect((self.server_entry.get(), int(self.port_entry.get())))
            self.connected = True
        except Exception as e:
            messagebox.showerror("Verbindungsfehler", f"Konnte nicht verbinden: {e}")
            return

        try:
            raw = self.client.recv(4096)
            msg = json.loads(raw.decode("utf-8"))
            if msg.get('type') != 'nick_request':
                raise ValueError("Unerwartete Antwort vom Server.")
        except Exception as e:
            messagebox.showerror("Protokollfehler", f"Handshake fehlgeschlagen: {e}")
            self.client.close()
            return

        self.nickname = simpledialog.askstring("Nickname", "Bitte gib deinen Nickname ein:", parent=self.window)
        if not self.nickname:
            self.client.close()
            return

        try:
            self.client.sendall((self.nickname + "\n").encode("utf-8"))
        except Exception as e:
            messagebox.showerror("Fehler", f"Senden fehlgeschlagen: {e}")
            self.client.close()
            return

        json_send(self.client, {'type': 'join', 'nickname': self.nickname})

        t = threading.Thread(target=self.receive_loop, daemon=True)
        t.start()

        self.connect_btn.config(state=tk.DISABLED)
        self.status_lbl.config(text=f"Verbunden als {self.nickname}")

    def receive_loop(self):
        buf = {"data": ""}
        try:
            for msg in json_recv_lines(self.client, buf):
                self.handle_message(msg)
        except Exception:
            pass
        finally:
            self.connected = False
            self.window.after(0, lambda: self.status_lbl.config(text="Verbindung getrennt"))

    # ---------------- Nachrichten-Handling -----------------------------------

    def handle_message(self, msg):
        t = msg.get('type')
        if t == 'state':
            rules = msg.get('rules') or {}
            if 'max_bet' in rules:
                self.max_bet = int(rules['max_bet'])
            if 'start_balance' in rules:
                sb = int(rules['start_balance'])
                self.window.after(0, lambda: self.rules_lbl.config(text=f"Regeln: Max Bet {self.max_bet} | Start {sb}"))
            self.game_state = msg
            self.window.after(0, self.update_ui)

        elif t == 'info':
            self.window.after(0, lambda: self.append_log(msg.get('message', '')))

        elif t == 'error':
            self.window.after(0, lambda: messagebox.showerror("Fehler", msg.get('message', 'Unbekannter Fehler')))

        elif t == 'chat':
            sender = msg.get('from', '?')
            text = msg.get('text', '')
            ts = msg.get('ts')
            timestr = time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "--:--:--"
            self.window.after(0, lambda: self.append_chat(f"[{timestr}] {sender}: {text}"))

    # ---------------- UI & Aktionen ------------------------------------------

    def append_log(self, text):
        self.log_txt.config(state=tk.NORMAL)
        self.log_txt.insert(tk.END, text + "\n")
        self.log_txt.see(tk.END)
        self.log_txt.config(state=tk.DISABLED)

    def append_chat(self, line):
        self.chat_txt.config(state=tk.NORMAL)
        self.chat_txt.insert(tk.END, line + "\n")
        self.chat_txt.see(tk.END)
        self.chat_txt.config(state=tk.DISABLED)

    def update_ui(self):
        if not self.game_state:
            return

        players = self.game_state.get('players', {})
        g = self.game_state.get('game_state', {})
        status = g.get('status', 'waiting')
        current = g.get('current_player')

        if self.nickname in players:
            p = players[self.nickname]
            self.balance_lbl.config(text=f"Balance: {p.get('balance', 0)}")
            hand = p.get('hand', [])
            self.hand_lbl.config(text=f"Karten: {', '.join(hand) if hand else '-'}")
            self.value_lbl.config(text=f"Wert: {self.calculate_hand_value(hand) if hand else '-'}")
        else:
            self.balance_lbl.config(text="Balance: -")
            self.hand_lbl.config(text="Karten: -")
            self.value_lbl.config(text="Wert: -")

        dealer = g.get('dealer_hand', [])
        self.dealer_hand_lbl.config(text=f"Karten: {', '.join(dealer) if dealer else '-'}")
        if dealer and dealer[0] == "[verdeckt]":
            self.dealer_value_lbl.config(text="Wert: ?")
        else:
            self.dealer_value_lbl.config(text=f"Wert: {self.calculate_hand_value(dealer) if dealer else '-'}")

        self.others_txt.config(state=tk.NORMAL)
        self.others_txt.delete(1.0, tk.END)
        for name, pdata in players.items():
            if name == self.nickname:
                continue
            h = pdata.get('hand', [])
            line = f"{name}: {', '.join(h) if h else '-'} (Wert: {self.calculate_hand_value(h) if h else '-'})"
            line += f" | Einsatz: {pdata.get('bet', 0)} | Status: {pdata.get('status', '-')}"
            res = pdata.get('result', '')
            if res:
                line += f" | Ergebnis: {res}"
            self.others_txt.insert(tk.END, line + "\n")
        self.others_txt.config(state=tk.DISABLED)

        self.bet_btn.config(state=tk.NORMAL if status == 'betting' and self.nickname in players and players[self.nickname]['bet'] == 0 else tk.DISABLED)
        my_turn = status == 'playing' and current == self.nickname and self.nickname in players and players[self.nickname]['status'] == 'playing'
        self.hit_btn.config(state=tk.NORMAL if my_turn else tk.DISABLED)
        self.stand_btn.config(state=tk.NORMAL if my_turn else tk.DISABLED)
        self.new_round_btn.config(state=tk.NORMAL if status == 'ended' else tk.DISABLED)

        status_text = {
            'waiting': "Warten auf Spieler...",
            'betting': "Einsatzphase",
            'playing': f"Am Zug: {current}",
            'dealer_turn': "Dealer zieht...",
            'ended': "Runde beendet"
        }.get(status, status)
        self.status_lbl.config(text=f"{status_text} | Du: {self.nickname}")

    @staticmethod
    def calculate_hand_value(hand):
        value = 0
        aces = 0
        for card in hand:
            if card == "[verdeckt]":
                return "?"
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

    # ---------------- Aktionen -----------------------------------------------

    def send_chat(self):
        if not self.connected:
            return
        text = self.chat_entry.get().strip()
        if not text:
            return
        json_send(self.client, {'type': 'chat', 'text': text})
        self.chat_entry.delete(0, tk.END)

    def place_bet(self):
        if not self.connected:
            return
        bet = simpledialog.askinteger(
            "Einsatz",
            f"Wie viel möchtest du setzen? (max {self.max_bet})",
            parent=self.window,
            minvalue=1,
            maxvalue=self.max_bet
        )
        if not bet:
            return
        json_send(self.client, {'type': 'bet', 'nickname': self.nickname, 'bet': bet})

    def hit(self):
        if not self.connected:
            return
        json_send(self.client, {'type': 'hit', 'nickname': self.nickname})

    def stand(self):
        if not self.connected:
            return
        json_send(self.client, {'type': 'stand', 'nickname': self.nickname})

    def new_round(self):
        if not self.connected:
            return
        json_send(self.client, {'type': 'new_round'})

    def run(self):
        self.window.mainloop()

if __name__ == "__main__":
    BlackjackClient().run()
