#!/usr/bin/env python3
"""
StandX x Decibel Hedge Bot — Python tkinter GUI
Node.js 백엔드(localhost:3847)를 subprocess로 실행하고 HTTP API로 통신한다.
"""

import tkinter as tk
from tkinter import ttk, messagebox
import threading
import subprocess
import urllib.request
import urllib.error
import json
import time
import os
import sys
import signal


# ── Constants ────────────────────────────────────────────────

BASE_URL = "http://127.0.0.1:3847"
POLL_INTERVAL_MS = 1000
SERVER_WAIT_TIMEOUT = 20  # 0.5s * 20 = 10s
MAX_LOG_LINES = 50

# ── Colors (Light Theme) ────────────────────────────────────

C_BG = "#FFFFFF"
C_BG_SECONDARY = "#F8F9FA"
C_BG_INPUT = "#F1F3F5"
C_BORDER = "#DEE2E6"
C_TEXT = "#212529"
C_TEXT_SECONDARY = "#6C757D"
C_ACCENT = "#4263EB"
C_ACCENT_HOVER = "#3B5BDB"
C_SUCCESS = "#2B8A3E"
C_DANGER = "#E03131"
C_WARNING = "#E67700"
C_LOG_BG = "#1A1B26"
C_LOG_FG = "#C0CAF5"


# ── API Helper ───────────────────────────────────────────────

def api_call(method: str, path: str, data: dict | None = None, timeout: float = 10) -> dict:
    """HTTP API 호출. 실패 시 예외를 던진다."""
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode("utf-8") if data else None
    req = urllib.request.Request(url, data=body, method=method)
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ── GUI ──────────────────────────────────────────────────────

class HedgeBotGUI:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("StandX \u00d7 Decibel Hedge Bot")
        self.root.geometry("1100x1000")
        self.root.minsize(900, 800)
        self.root.configure(bg=C_BG)

        self._server_proc: subprocess.Popen | None = None
        self._polling = False
        self._server_ready = False
        self._prev_log_count = 0

        # ttk style
        self._setup_style()

        # Main PanedWindow (horizontal split)
        paned = ttk.PanedWindow(root, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        # Left panel (settings + controls)
        left_frame = ttk.Frame(paned, width=420)
        paned.add(left_frame, weight=1)

        # Right panel (status + logs)
        right_frame = ttk.Frame(paned, width=600)
        paned.add(right_frame, weight=2)

        self._build_left_panel(left_frame)
        self._build_right_panel(right_frame)

        # Disable controls until server is ready
        self._set_controls_state("disabled")

        # Start server in background thread
        threading.Thread(target=self._start_server, daemon=True).start()

    # ── Style ────────────────────────────────────────────────

    def _setup_style(self):
        style = ttk.Style()
        style.theme_use("clam")

        style.configure(".", background=C_BG, foreground=C_TEXT, font=("Helvetica", 12))
        style.configure("TFrame", background=C_BG)
        style.configure("TLabel", background=C_BG, foreground=C_TEXT, font=("Helvetica", 12))
        style.configure("TLabelframe", background=C_BG, foreground=C_TEXT, font=("Helvetica", 12, "bold"))
        style.configure("TLabelframe.Label", background=C_BG, foreground=C_TEXT, font=("Helvetica", 12, "bold"))
        style.configure("TEntry", fieldbackground=C_BG_INPUT, foreground=C_TEXT, font=("Consolas", 12))
        style.configure("TCombobox", fieldbackground=C_BG_INPUT, foreground=C_TEXT, font=("Consolas", 12))
        style.configure("TButton", font=("Helvetica", 12, "bold"), padding=(12, 6))

        # Accent button
        style.configure("Accent.TButton", background=C_ACCENT, foreground="#FFFFFF", font=("Helvetica", 12, "bold"))
        style.map("Accent.TButton",
                   background=[("active", C_ACCENT_HOVER), ("disabled", C_BORDER)])

        # Start button (green)
        style.configure("Start.TButton", background=C_SUCCESS, foreground="#FFFFFF", font=("Helvetica", 13, "bold"))
        style.map("Start.TButton",
                   background=[("active", "#237032"), ("disabled", C_BORDER)])

        # Stop button (red)
        style.configure("Stop.TButton", background=C_DANGER, foreground="#FFFFFF", font=("Helvetica", 13, "bold"))
        style.map("Stop.TButton",
                   background=[("active", "#C92A2A"), ("disabled", C_BORDER)])

        # Status labels
        style.configure("StatusKey.TLabel", background=C_BG, foreground=C_TEXT_SECONDARY, font=("Helvetica", 11))
        style.configure("StatusVal.TLabel", background=C_BG, foreground=C_TEXT, font=("Consolas", 12))
        style.configure("Connected.TLabel", background=C_BG, foreground=C_SUCCESS, font=("Consolas", 12, "bold"))
        style.configure("Disconnected.TLabel", background=C_BG, foreground=C_DANGER, font=("Consolas", 12, "bold"))
        style.configure("Running.TLabel", background=C_BG, foreground=C_SUCCESS, font=("Consolas", 13, "bold"))
        style.configure("Stopped.TLabel", background=C_BG, foreground=C_TEXT_SECONDARY, font=("Consolas", 13, "bold"))
        style.configure("Error.TLabel", background=C_BG, foreground=C_DANGER, font=("Consolas", 11))
        style.configure("ServerWait.TLabel", background=C_BG, foreground=C_WARNING, font=("Helvetica", 11))

    # ── Left Panel ───────────────────────────────────────────

    def _build_left_panel(self, parent: ttk.Frame):
        canvas = tk.Canvas(parent, bg=C_BG, highlightthickness=0)
        scrollbar = ttk.Scrollbar(parent, orient=tk.VERTICAL, command=canvas.yview)
        scroll_frame = ttk.Frame(canvas)

        scroll_frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas_window = canvas.create_window((0, 0), window=scroll_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)

        # scroll_frame 너비를 canvas에 맞추기
        canvas.bind("<Configure>", lambda e: canvas.itemconfig(canvas_window, width=e.width))

        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Bind mousewheel for canvas scrolling (macOS/Windows/Linux)
        def _on_mousewheel(event):
            if sys.platform == "darwin":
                canvas.yview_scroll(-1 * event.delta, "units")
            else:
                canvas.yview_scroll(-1 * (event.delta // 120), "units")

        canvas.bind_all("<MouseWheel>", _on_mousewheel)
        # Linux
        canvas.bind_all("<Button-4>", lambda e: canvas.yview_scroll(-3, "units"))
        canvas.bind_all("<Button-5>", lambda e: canvas.yview_scroll(3, "units"))

        # Server status
        self._lbl_server = ttk.Label(scroll_frame, text="서버 시작 중...", style="ServerWait.TLabel")
        self._lbl_server.pack(anchor="w", padx=8, pady=(8, 4))

        # --- Credentials Section ---
        cred_frame = ttk.LabelFrame(scroll_frame, text="인증 정보", padding=10)
        cred_frame.pack(fill=tk.X, padx=8, pady=(4, 8))

        # ? 도움말 버튼
        help_frame = ttk.Frame(cred_frame)
        help_frame.pack(fill=tk.X)
        help_btn = tk.Button(
            help_frame, text=" ? ", font=("Helvetica", 11, "bold"),
            bg="#2563eb", fg="white", relief="flat", bd=0, padx=6, pady=1,
            cursor="hand2", command=self._show_credential_help,
        )
        help_btn.pack(side=tk.RIGHT)
        ttk.Label(help_frame, text="인증 키 발급 방법", style="StatusKey.TLabel").pack(side=tk.RIGHT, padx=(0, 4))

        self._ent_standx_key = self._add_field(cred_frame, "StandX EVM 개인키", show="*")
        self._ent_decibel_key = self._add_field(cred_frame, "Decibel 지갑 키", show="*")
        self._ent_decibel_bearer = self._add_field(cred_frame, "Decibel Bearer Token", show="*")
        self._ent_decibel_sub = self._add_field(cred_frame, "Decibel Subaccount (선택)")

        # Show/hide toggle + connect button
        self._show_keys = False
        btn_frame_cred = ttk.Frame(cred_frame)
        btn_frame_cred.pack(fill=tk.X, pady=(8, 0))

        self._btn_toggle_keys = ttk.Button(btn_frame_cred, text="키 보기", command=self._toggle_keys)
        self._btn_toggle_keys.pack(side=tk.LEFT, padx=(0, 8))

        self._btn_connect = ttk.Button(btn_frame_cred, text="연결", command=self._on_connect, style="Accent.TButton")
        self._btn_connect.pack(side=tk.RIGHT)

        # --- Trading Settings Section ---
        config_frame = ttk.LabelFrame(scroll_frame, text="트레이딩 설정", padding=10)
        config_frame.pack(fill=tk.X, padx=8, pady=(0, 8))

        # ? 도움말 버튼
        config_help_frame = ttk.Frame(config_frame)
        config_help_frame.pack(fill=tk.X)
        config_help_btn = tk.Button(
            config_help_frame, text=" ? ", font=("Helvetica", 11, "bold"),
            bg="#2563eb", fg="white", relief="flat", bd=0, padx=6, pady=1,
            cursor="hand2", command=self._show_config_help,
        )
        config_help_btn.pack(side=tk.RIGHT)
        ttk.Label(config_help_frame, text="설정 설명", style="StatusKey.TLabel").pack(side=tk.RIGHT, padx=(0, 4))

        self._ent_symbol = self._add_field(config_frame, "심볼", default="BTC")
        self._ent_order_size = self._add_field(config_frame, "주문 크기 (BTC)", default="0.001")
        self._ent_leverage = self._add_field(config_frame, "레버리지 (1-40)", default="10")
        self._ent_tolerance = self._add_field(config_frame, "가격 허용 오차", default="1")

        # Rotation mode combobox
        rot_label = ttk.Label(config_frame, text="로테이션 모드")
        rot_label.pack(anchor="w", pady=(6, 2))
        self._cmb_rotation = ttk.Combobox(config_frame, values=["fixed", "random"], state="readonly")
        self._cmb_rotation.set("fixed")
        self._cmb_rotation.pack(fill=tk.X, pady=(0, 4))

        self._ent_rotation_sec = self._add_field(config_frame, "로테이션 간격 (초)", default="120")

        # Initial long exchange
        exch_label = ttk.Label(config_frame, text="초기 롱 거래소")
        exch_label.pack(anchor="w", pady=(6, 2))
        self._cmb_exchange = ttk.Combobox(config_frame, values=["standx", "decibel"], state="readonly")
        self._cmb_exchange.set("standx")
        self._cmb_exchange.pack(fill=tk.X, pady=(0, 4))

        # Config save button
        save_btn_frame = ttk.Frame(config_frame)
        save_btn_frame.pack(fill=tk.X, pady=(8, 0))
        self._btn_save_config = ttk.Button(save_btn_frame, text="설정 저장", command=self._on_save_config, style="Accent.TButton")
        self._btn_save_config.pack(side=tk.RIGHT)

        # --- Control Section ---
        ctrl_frame = ttk.LabelFrame(scroll_frame, text="제어", padding=10)
        ctrl_frame.pack(fill=tk.X, padx=8, pady=(0, 8))

        btn_row = ttk.Frame(ctrl_frame)
        btn_row.pack(fill=tk.X)

        self._btn_start = ttk.Button(btn_row, text="\u25b6  Start", command=self._on_start, style="Start.TButton")
        self._btn_start.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 4))

        self._btn_stop = ttk.Button(btn_row, text="\u25a0  Stop", command=self._on_stop, style="Stop.TButton")
        self._btn_stop.pack(side=tk.RIGHT, expand=True, fill=tk.X, padx=(4, 0))

    def _add_field(self, parent: tk.Widget, label_text: str, default: str = "", show: str = "") -> ttk.Entry:
        """라벨 + Entry 한 줄 추가. Entry 위젯을 리턴. 클립보드 바인딩 자동 적용."""
        lbl = ttk.Label(parent, text=label_text)
        lbl.pack(anchor="w", pady=(6, 2))
        ent = ttk.Entry(parent, show=show) if show else ttk.Entry(parent)
        if default:
            ent.insert(0, default)
        ent.pack(fill=tk.X, pady=(0, 2))
        self._bind_clipboard(ent)
        return ent

    # ── Clipboard ────────────────────────────────────────────

    def _bind_clipboard(self, widget: ttk.Entry):
        """Entry 위젯에 Cmd+V/C/X/A + 우클릭 메뉴 바인딩."""
        # Cmd+V (macOS), Ctrl+V (Windows/Linux) — 모든 조합 바인딩
        for mod in ("<Command-v>", "<Control-v>", "<Meta-v>"):
            widget.bind(mod, self._do_paste)
        for mod in ("<Command-c>", "<Control-c>", "<Meta-c>"):
            widget.bind(mod, self._do_copy)
        for mod in ("<Command-x>", "<Control-x>", "<Meta-x>"):
            widget.bind(mod, self._do_cut)
        for mod in ("<Command-a>", "<Control-a>", "<Meta-a>"):
            widget.bind(mod, self._do_select_all)
        # 우클릭: macOS Button-2 + Button-3 + Control-Button-1
        for btn in ("<Button-2>", "<Button-3>", "<Control-Button-1>"):
            widget.bind(btn, self._show_context_menu)

    def _do_paste(self, event):
        w = event.widget
        try:
            text = self.root.clipboard_get()
        except tk.TclError:
            return "break"
        try:
            w.delete("sel.first", "sel.last")
        except tk.TclError:
            pass
        w.insert("insert", text)
        return "break"

    def _do_copy(self, event):
        w = event.widget
        try:
            text = w.selection_get()
            self.root.clipboard_clear()
            self.root.clipboard_append(text)
        except tk.TclError:
            pass
        return "break"

    def _do_cut(self, event):
        self._do_copy(event)
        try:
            event.widget.delete("sel.first", "sel.last")
        except tk.TclError:
            pass
        return "break"

    def _do_select_all(self, event):
        event.widget.select_range(0, tk.END)
        event.widget.icursor(tk.END)
        return "break"

    def _show_context_menu(self, event):
        w = event.widget
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="붙여넣기", command=lambda: self._do_paste(type("E", (), {"widget": w})()))
        menu.add_command(label="복사", command=lambda: self._do_copy(type("E", (), {"widget": w})()))
        menu.add_command(label="잘라내기", command=lambda: self._do_cut(type("E", (), {"widget": w})()))
        menu.add_separator()
        menu.add_command(label="전체 선택", command=lambda: (w.select_range(0, tk.END), w.icursor(tk.END)))
        menu.tk_popup(event.x_root, event.y_root)

    # ── Credential Help ──────────────────────────────────────

    def _show_credential_help(self):
        """인증 키 발급 방법 안내 팝업."""
        import webbrowser
        win = tk.Toplevel(self.root)
        win.title("인증 키 발급 방법")
        win.geometry("640x600")
        win.configure(bg="white")
        win.transient(self.root)
        win.grab_set()

        # 스크롤 가능 Text
        frame = ttk.Frame(win)
        frame.pack(fill=tk.BOTH, expand=True)
        scrollbar = tk.Scrollbar(frame, orient=tk.VERTICAL)
        txt = tk.Text(frame, wrap=tk.WORD, font=("Helvetica", 12), bg="white",
                      fg="#1a1a2e", padx=16, pady=16, relief="flat", spacing2=4,
                      yscrollcommand=scrollbar.set)
        scrollbar.configure(command=txt.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        txt.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # 링크 스타일
        txt.tag_configure("link", foreground="#2563eb", underline=True)
        txt.tag_bind("link_geomi", "<Button-1>", lambda e: webbrowser.open("https://geomi.dev"))
        txt.tag_bind("link_geomi", "<Enter>", lambda e: txt.configure(cursor="hand2"))
        txt.tag_bind("link_geomi", "<Leave>", lambda e: txt.configure(cursor=""))
        txt.tag_bind("link_geomi_docs", "<Button-1>", lambda e: webbrowser.open("https://geomi.dev/docs/api-keys"))
        txt.tag_bind("link_geomi_docs", "<Enter>", lambda e: txt.configure(cursor="hand2"))
        txt.tag_bind("link_geomi_docs", "<Leave>", lambda e: txt.configure(cursor=""))
        txt.tag_bind("link_petra", "<Button-1>", lambda e: webbrowser.open("https://petra.app"))
        txt.tag_bind("link_petra", "<Enter>", lambda e: txt.configure(cursor="hand2"))
        txt.tag_bind("link_petra", "<Leave>", lambda e: txt.configure(cursor=""))
        txt.tag_bind("link_decibel_api", "<Button-1>", lambda e: webbrowser.open("https://app.decibel.trade/api"))
        txt.tag_bind("link_decibel_api", "<Enter>", lambda e: txt.configure(cursor="hand2"))
        txt.tag_bind("link_decibel_api", "<Leave>", lambda e: txt.configure(cursor=""))

        def _insert(text, *tags):
            txt.insert(tk.END, text, tags)

        _insert("인증 키 발급 방법\n\n")

        _insert("1. StandX EVM 개인키\n\n")
        _insert("""  MetaMask 또는 EVM 호환 지갑의 개인키입니다.

  발급 방법:
  1) MetaMask 브라우저 확장 열기
  2) 상단 계정 아이콘 클릭
  3) "계정 세부정보" 선택
  4) "개인키 내보내기" 클릭
  5) MetaMask 비밀번호 입력 후 확인
  6) 표시된 개인키 복사 (0x... 형태)

  참고:
  - 0x 접두사 포함/미포함 모두 가능
  - BSC(BNB Chain) 네트워크에서 사용
  - StandX 거래에 사용하는 지갑과 동일해야 합니다

""")

        _insert("2. Decibel 지갑 키 (API Wallet)\n\n")
        _insert("  Decibel API 전용 지갑입니다. Decibel 사이트에서 생성합니다.\n\n")
        _insert("  생성 페이지: ")
        _insert("https://app.decibel.trade/api", "link", "link_decibel_api")
        _insert("""

  발급 방법:
  1) 위 링크 클릭하여 Decibel API 페이지 접속
  2) Petra Wallet 연결 또는 "Continue with Google"
  3) "Create API Wallet" 클릭
  4) Private Key 즉시 복사 (1회만 표시됨!)
  5) Wallet Address도 따로 저장

  주의:
  - Private Key는 생성 시 1번만 표시됩니다
  - 복사하지 않으면 다시 볼 수 없습니다
  - 이 지갑에 APT (가스비)가 필요합니다

""")

        _insert("3. Decibel Bearer Token (Geomi 발급)\n\n")
        _insert("  Decibel API 인증에 필요한 Bearer Token입니다.\n")
        _insert("  Geomi 사이트: ")
        _insert("https://geomi.dev", "link", "link_geomi")
        _insert("""

  발급 방법:
  1) 위 Geomi 링크 클릭하여 접속
  2) 가입/로그인
  3) 프로젝트 생성 또는 기존 프로젝트 선택
  4) "API Key" 카드 클릭
  5) 설정:
     - API Key Name: 예) decibel
     - Network: "Decibel Devnet" 선택
     - Client usage: OFF
  6) "Create New API Key" 클릭
  7) "Key secret" 열에서 Bearer Token 복사

  상세 문서: """)
        _insert("https://geomi.dev/docs/api-keys", "link", "link_geomi_docs")
        _insert("""

  참고:
  - 키 노출 시 즉시 Geomi에서 삭제 후 재발급

""")

        _insert("4. Decibel Subaccount (선택)\n\n")
        _insert("""  서브계정을 사용하는 경우에만 입력합니다.
  메인 계정만 사용하면 비워두세요.

""")

        _insert("보안 안내\n\n")
        _insert("""  - 개인키는 절대 타인에게 공유하지 마세요
  - 입력된 키는 외부 서버에 전송되지 않습니다
  - 모든 통신은 localhost(127.0.0.1) 내부에서만 이루어집니다
  - 프로그램 종료 시 메모리에서 자동 삭제됩니다
""")

        txt.configure(state=tk.DISABLED)

        close_btn = ttk.Button(win, text="닫기", command=win.destroy, style="Accent.TButton")
        close_btn.pack(pady=(0, 12))

    def _show_config_help(self):
        """트레이딩 설정 안내 팝업."""
        win = tk.Toplevel(self.root)
        win.title("트레이딩 설정 설명")
        win.geometry("600x560")
        win.configure(bg="white")
        win.transient(self.root)
        win.grab_set()

        txt = tk.Text(win, wrap=tk.WORD, font=("Helvetica", 12), bg="white",
                      fg="#1a1a2e", padx=16, pady=16, relief="flat", spacing2=4)
        txt.pack(fill=tk.BOTH, expand=True)

        content = """📊 트레이딩 설정 설명

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📌 심볼
  거래할 자산. 기본값: BTC

📌 주문 크기 (BTC)
  한쪽 거래소에 주문할 수량 (BTC 단위)
  예: 0.001 = 약 $87 (BTC $87,000 기준)

📌 레버리지 (1-40)
  양쪽 거래소에 동일하게 적용되는 레버리지 배수
  높을수록 적은 마진으로 큰 포지션, 청산 위험 증가

📌 가격 허용 오차
  양쪽 거래소 가격 차이 허용 범위 ($)
  가격차가 이 값을 초과하면 주문을 보류
  예: 1 = 양쪽 가격 차이 $1 이내에서만 실행

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📌 로테이션 모드
  • fixed: 고정 간격으로 롱/숏 방향 전환
  • random: 최소~최대 범위 내 랜덤 간격으로 전환

📌 로테이션 간격 (초)
  롱/숏 방향을 바꾸는 주기 (초 단위)
  예: 120 = 2분마다 방향 전환
  fixed 모드에서 사용. random은 별도 최소/최대 설정

📌 초기 롱 거래소
  봇 시작 시 롱 포지션을 잡을 거래소
  • standx → StandX 롱 + Decibel 숏
  • decibel → Decibel 롱 + StandX 숏
  로테이션마다 방향이 반전됨

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 헷징 원리
  양쪽 거래소에 동시에 롱/숏 진입
  → 가격 변동 위험 0 (양빵)
  → 거래량만 발생 → 수수료/리워드 수취
"""
        txt.insert("1.0", content)
        txt.configure(state=tk.DISABLED)

        close_btn = ttk.Button(win, text="닫기", command=win.destroy, style="Accent.TButton")
        close_btn.pack(pady=(0, 12))

    # ── Right Panel ──────────────────────────────────────────

    def _build_right_panel(self, parent: ttk.Frame):
        parent.columnconfigure(0, weight=1)

        # --- Connection Status ---
        conn_frame = ttk.LabelFrame(parent, text="연결 상태", padding=10)
        conn_frame.pack(fill=tk.X, padx=8, pady=(0, 8))

        row_standx = ttk.Frame(conn_frame)
        row_standx.pack(fill=tk.X, pady=2)
        ttk.Label(row_standx, text="StandX:", style="StatusKey.TLabel").pack(side=tk.LEFT)
        self._lbl_standx_conn = ttk.Label(row_standx, text="--", style="Disconnected.TLabel")
        self._lbl_standx_conn.pack(side=tk.LEFT, padx=(8, 0))

        row_decibel = ttk.Frame(conn_frame)
        row_decibel.pack(fill=tk.X, pady=2)
        ttk.Label(row_decibel, text="Decibel:", style="StatusKey.TLabel").pack(side=tk.LEFT)
        self._lbl_decibel_conn = ttk.Label(row_decibel, text="--", style="Disconnected.TLabel")
        self._lbl_decibel_conn.pack(side=tk.LEFT, padx=(8, 0))

        # --- Balances ---
        bal_frame = ttk.LabelFrame(parent, text="잔고", padding=10)
        bal_frame.pack(fill=tk.X, padx=8, pady=(0, 8))

        row_sbal = ttk.Frame(bal_frame)
        row_sbal.pack(fill=tk.X, pady=2)
        ttk.Label(row_sbal, text="StandX:", style="StatusKey.TLabel").pack(side=tk.LEFT)
        self._lbl_standx_bal = ttk.Label(row_sbal, text="--", style="StatusVal.TLabel")
        self._lbl_standx_bal.pack(side=tk.LEFT, padx=(8, 0))

        row_dbal = ttk.Frame(bal_frame)
        row_dbal.pack(fill=tk.X, pady=2)
        ttk.Label(row_dbal, text="Decibel:", style="StatusKey.TLabel").pack(side=tk.LEFT)
        self._lbl_decibel_bal = ttk.Label(row_dbal, text="--", style="StatusVal.TLabel")
        self._lbl_decibel_bal.pack(side=tk.LEFT, padx=(8, 0))

        # --- Positions ---
        pos_frame = ttk.LabelFrame(parent, text="포지션", padding=10)
        pos_frame.pack(fill=tk.X, padx=8, pady=(0, 8))

        row_spos = ttk.Frame(pos_frame)
        row_spos.pack(fill=tk.X, pady=2)
        ttk.Label(row_spos, text="StandX:", style="StatusKey.TLabel").pack(side=tk.LEFT)
        self._lbl_standx_pos = ttk.Label(row_spos, text="--", style="StatusVal.TLabel")
        self._lbl_standx_pos.pack(side=tk.LEFT, padx=(8, 0))

        row_dpos = ttk.Frame(pos_frame)
        row_dpos.pack(fill=tk.X, pady=2)
        ttk.Label(row_dpos, text="Decibel:", style="StatusKey.TLabel").pack(side=tk.LEFT)
        self._lbl_decibel_pos = ttk.Label(row_dpos, text="--", style="StatusVal.TLabel")
        self._lbl_decibel_pos.pack(side=tk.LEFT, padx=(8, 0))

        # --- Bot Status ---
        bot_frame = ttk.LabelFrame(parent, text="봇 상태", padding=10)
        bot_frame.pack(fill=tk.X, padx=8, pady=(0, 8))

        row_running = ttk.Frame(bot_frame)
        row_running.pack(fill=tk.X, pady=2)
        ttk.Label(row_running, text="상태:", style="StatusKey.TLabel").pack(side=tk.LEFT)
        self._lbl_bot_status = ttk.Label(row_running, text="정지", style="Stopped.TLabel")
        self._lbl_bot_status.pack(side=tk.LEFT, padx=(8, 0))

        row_cycle = ttk.Frame(bot_frame)
        row_cycle.pack(fill=tk.X, pady=2)
        ttk.Label(row_cycle, text="사이클:", style="StatusKey.TLabel").pack(side=tk.LEFT)
        self._lbl_cycle = ttk.Label(row_cycle, text="0", style="StatusVal.TLabel")
        self._lbl_cycle.pack(side=tk.LEFT, padx=(8, 0))

        # --- Error ---
        err_frame = ttk.LabelFrame(parent, text="에러", padding=10)
        err_frame.pack(fill=tk.X, padx=8, pady=(0, 8))
        self._lbl_error = ttk.Label(err_frame, text="", style="Error.TLabel", wraplength=500)
        self._lbl_error.pack(fill=tk.X)

        # --- Logs ---
        log_frame = ttk.LabelFrame(parent, text="로그", padding=4)
        log_frame.pack(fill=tk.BOTH, expand=True, padx=8, pady=(0, 8))

        self._txt_log = tk.Text(
            log_frame,
            bg=C_LOG_BG,
            fg=C_LOG_FG,
            font=("Consolas", 10),
            wrap=tk.WORD,
            state=tk.DISABLED,
            relief=tk.FLAT,
            padx=8,
            pady=8,
        )
        log_scroll = ttk.Scrollbar(log_frame, orient=tk.VERTICAL, command=self._txt_log.yview)
        self._txt_log.configure(yscrollcommand=log_scroll.set)

        self._txt_log.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        log_scroll.pack(side=tk.RIGHT, fill=tk.Y)

    # ── Server Management ────────────────────────────────────

    def _start_server(self):
        """백엔드 서버를 subprocess로 시작하고 준비될 때까지 대기."""
        # PyInstaller --onefile: __file__은 임시 디렉토리, sys.executable이 실제 EXE 위치
        if getattr(sys, 'frozen', False):
            project_dir = os.path.dirname(sys.executable)
        else:
            project_dir = os.path.dirname(os.path.abspath(__file__))

        # 1순위: 번들된 server.exe (pkg로 빌드, Node.js 불필요)
        server_exe = os.path.join(project_dir, "server.exe")
        dist_index = os.path.join(project_dir, "dist", "index.js")

        if os.path.exists(server_exe):
            cmd = [server_exe]
        elif os.path.exists(dist_index):
            # 2순위: node + dist/index.js (개발 환경)
            local_node = os.path.join(project_dir, "node.exe")
            if sys.platform == "win32" and os.path.exists(local_node):
                node_cmd = local_node
            else:
                node_cmd = "node.exe" if sys.platform == "win32" else "node"
            cmd = [node_cmd, dist_index]
        else:
            # 3순위: npm run build 후 재시도
            self.root.after(0, lambda: self._lbl_server.configure(text="빌드 중 (npm run build)..."))
            try:
                subprocess.run(
                    ["npm", "run", "build"],
                    cwd=project_dir,
                    check=True,
                    capture_output=True,
                    timeout=60,
                )
                cmd = ["node.exe" if sys.platform == "win32" else "node", dist_index]
            except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
                self.root.after(0, lambda: self._server_error(f"서버를 시작할 수 없습니다.\nserver.exe 또는 Node.js가 필요합니다.\n{e}"))
                return

        # 서버 시작
        self.root.after(0, lambda: self._lbl_server.configure(text="서버 시작 중..."))
        try:
            self._server_proc = subprocess.Popen(
                cmd,
                cwd=project_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env={k: os.environ[k] for k in ("PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "NODE_ENV") if k in os.environ},
            )
        except FileNotFoundError:
            self.root.after(0, lambda: self._server_error("서버 실행 파일을 찾을 수 없습니다."))
            return

        # 서버 준비 대기
        ready = False
        for _ in range(SERVER_WAIT_TIMEOUT):
            if self._server_proc.poll() is not None:
                # 서버가 종료됨
                output = ""
                if self._server_proc.stdout:
                    output = self._server_proc.stdout.read().decode("utf-8", errors="replace")
                self.root.after(0, lambda: self._server_error(f"서버 즉시 종료됨.\n{output[:500]}"))
                return
            try:
                resp = api_call("GET", "/api/status", timeout=1)
                if isinstance(resp, dict):
                    ready = True
                    break
            except Exception:
                time.sleep(0.5)

        if not ready:
            self.root.after(0, lambda: self._server_error("서버 시작 시간 초과 (10초)."))
            return

        self._server_ready = True
        self.root.after(0, self._on_server_ready)

    def _on_server_ready(self):
        """서버 준비 완료 시 GUI 활성화."""
        self._lbl_server.configure(text="서버 연결됨", foreground=C_SUCCESS)
        self._set_controls_state("normal")
        self._append_log("[GUI] 서버 연결 완료. 인증 정보를 입력하고 연결하세요.")

    def _server_error(self, msg: str):
        """서버 시작 실패."""
        self._lbl_server.configure(text="서버 오류", foreground=C_DANGER)
        messagebox.showerror("서버 오류", msg)

    # ── Control State ────────────────────────────────────────

    def _set_controls_state(self, state: str):
        """모든 입력/버튼 활성화 또는 비활성화."""
        widgets = [
            self._ent_standx_key, self._ent_decibel_key,
            self._ent_decibel_bearer, self._ent_decibel_sub,
            self._ent_symbol, self._ent_order_size,
            self._ent_leverage, self._ent_tolerance,
            self._ent_rotation_sec,
        ]
        for w in widgets:
            w.configure(state=state)

        combo_state = "readonly" if state == "normal" else "disabled"
        self._cmb_rotation.configure(state=combo_state)
        self._cmb_exchange.configure(state=combo_state)

        btn_state = state
        for btn in [self._btn_connect, self._btn_save_config, self._btn_start, self._btn_stop, self._btn_toggle_keys]:
            btn.configure(state=btn_state)

    # ── Actions ──────────────────────────────────────────────

    def _toggle_keys(self):
        """개인키 show/hide 전환."""
        self._show_keys = not self._show_keys
        show_char = "" if self._show_keys else "*"
        self._ent_standx_key.configure(show=show_char)
        self._ent_decibel_key.configure(show=show_char)
        self._ent_decibel_bearer.configure(show=show_char)
        self._btn_toggle_keys.configure(text="키 숨기기" if self._show_keys else "키 보기")

    def _on_connect(self):
        """인증 정보 전송 (비동기)."""
        standx_key = self._ent_standx_key.get().strip()
        decibel_key = self._ent_decibel_key.get().strip()
        decibel_bearer = self._ent_decibel_bearer.get().strip()
        decibel_sub = self._ent_decibel_sub.get().strip()

        if not standx_key or not decibel_key or not decibel_bearer:
            messagebox.showwarning("입력 오류", "필수 인증 정보를 모두 입력하세요.")
            return

        self._btn_connect.configure(state="disabled")
        self._append_log("[GUI] 거래소 연결 중...")

        def _connect():
            try:
                payload = {
                    "standx_evm_key": standx_key,
                    "decibel_wallet_key": decibel_key,
                    "decibel_bearer": decibel_bearer,
                }
                if decibel_sub:
                    payload["decibel_subaccount"] = decibel_sub

                result = api_call("POST", "/api/credentials", payload, timeout=30)

                if result.get("success"):
                    balances = result.get("balances", {})
                    addresses = result.get("addresses", {})
                    s_bal = balances.get("standx", {})
                    d_bal = balances.get("decibel", {})

                    def _update():
                        self._lbl_standx_conn.configure(text="연결됨", style="Connected.TLabel")
                        self._lbl_decibel_conn.configure(text="연결됨", style="Connected.TLabel")
                        self._lbl_standx_bal.configure(text=f"${s_bal.get('available', '0')} (equity: ${s_bal.get('equity', '0')})")
                        self._lbl_decibel_bal.configure(text=f"${d_bal.get('available', '0')} (equity: ${d_bal.get('equity', '0')})")
                        self._btn_connect.configure(state="normal", text="재연결")
                        self._append_log(f"[GUI] 연결 성공 | StandX: {addresses.get('standx', '')[:10]}... | Decibel: {addresses.get('decibel', '')[:10]}...")

                    self.root.after(0, _update)
                else:
                    error_msg = result.get("error", "알 수 없는 오류")
                    self.root.after(0, lambda: (
                        messagebox.showerror("연결 실패", error_msg),
                        self._btn_connect.configure(state="normal"),
                        self._append_log(f"[GUI] 연결 실패: {error_msg}"),
                    ))
            except Exception as e:
                self.root.after(0, lambda: (
                    messagebox.showerror("연결 오류", str(e)),
                    self._btn_connect.configure(state="normal"),
                    self._append_log(f"[GUI] 연결 오류: {e}"),
                ))

        threading.Thread(target=_connect, daemon=True).start()

    def _on_save_config(self):
        """설정 저장."""
        try:
            order_size = self._ent_order_size.get().strip()
            leverage = int(self._ent_leverage.get().strip())
            tolerance = float(self._ent_tolerance.get().strip())
            rotation_sec = int(self._ent_rotation_sec.get().strip())
            rotation_ms = rotation_sec * 1000

            payload = {
                "symbol": self._ent_symbol.get().strip() or "BTC",
                "orderSize": order_size,
                "leverage": leverage,
                "priceTolerance": tolerance,
                "rotationMode": self._cmb_rotation.get(),
                "rotationIntervalMs": rotation_ms,
                "initialLongExchange": self._cmb_exchange.get(),
                "walletMode": "shared",
            }

            self._btn_save_config.configure(state="disabled")
            self._append_log("[GUI] 설정 저장 중...")

            def _save():
                try:
                    result = api_call("POST", "/api/config", payload)
                    if result.get("success"):
                        self.root.after(0, lambda: (
                            self._append_log("[GUI] 설정 저장 완료."),
                            self._btn_save_config.configure(state="normal"),
                        ))
                    else:
                        error_msg = result.get("error", "알 수 없는 오류")
                        self.root.after(0, lambda: (
                            messagebox.showerror("설정 오류", error_msg),
                            self._btn_save_config.configure(state="normal"),
                            self._append_log(f"[GUI] 설정 오류: {error_msg}"),
                        ))
                except Exception as e:
                    self.root.after(0, lambda: (
                        messagebox.showerror("설정 오류", str(e)),
                        self._btn_save_config.configure(state="normal"),
                    ))

            threading.Thread(target=_save, daemon=True).start()

        except ValueError as e:
            messagebox.showwarning("입력 오류", f"잘못된 값이 있습니다: {e}")

    def _on_start(self):
        """봇 시작."""
        self._btn_start.configure(state="disabled")
        self._append_log("[GUI] 봇 시작 요청...")

        def _start():
            try:
                result = api_call("POST", "/api/start")
                if result.get("success"):
                    self._polling = True
                    self.root.after(0, lambda: (
                        self._append_log("[GUI] 봇 시작됨."),
                        self._btn_start.configure(state="disabled"),
                        self._btn_stop.configure(state="normal"),
                    ))
                    # 폴링 시작
                    self.root.after(POLL_INTERVAL_MS, self._poll_status)
                else:
                    error_msg = result.get("error", "알 수 없는 오류")
                    self.root.after(0, lambda: (
                        messagebox.showerror("시작 실패", error_msg),
                        self._btn_start.configure(state="normal"),
                        self._append_log(f"[GUI] 시작 실패: {error_msg}"),
                    ))
            except Exception as e:
                self.root.after(0, lambda: (
                    messagebox.showerror("시작 오류", str(e)),
                    self._btn_start.configure(state="normal"),
                ))

        threading.Thread(target=_start, daemon=True).start()

    def _on_stop(self):
        """봇 정지."""
        self._btn_stop.configure(state="disabled")
        self._append_log("[GUI] 봇 정지 요청...")

        def _stop():
            try:
                result = api_call("POST", "/api/stop")
                self._polling = False
                if result.get("success"):
                    self.root.after(0, lambda: (
                        self._append_log("[GUI] 봇 정지됨."),
                        self._btn_start.configure(state="normal"),
                        self._btn_stop.configure(state="disabled"),
                        self._lbl_bot_status.configure(text="정지", style="Stopped.TLabel"),
                    ))
                else:
                    error_msg = result.get("error", "알 수 없는 오류")
                    self.root.after(0, lambda: (
                        self._append_log(f"[GUI] 정지 실패: {error_msg}"),
                        self._btn_start.configure(state="normal"),
                        self._btn_stop.configure(state="normal"),
                    ))
            except Exception as e:
                self._polling = False
                self.root.after(0, lambda: (
                    self._append_log(f"[GUI] 정지 오류: {e}"),
                    self._btn_start.configure(state="normal"),
                    self._btn_stop.configure(state="normal"),
                ))

        threading.Thread(target=_stop, daemon=True).start()

    # ── Status Polling ───────────────────────────────────────

    def _poll_status(self):
        """1초마다 GET /api/status 호출 후 우측 패널 업데이트."""
        if not self._polling:
            return

        def _fetch():
            try:
                data = api_call("GET", "/api/status", timeout=3)
                self.root.after(0, lambda: self._update_status(data))
            except Exception:
                pass
            finally:
                self.root.after(0, self._schedule_next_poll)

        threading.Thread(target=_fetch, daemon=True).start()

    def _schedule_next_poll(self):
        """메인 스레드에서 다음 폴링 예약."""
        if self._polling:
            self.root.after(POLL_INTERVAL_MS, self._poll_status)

    def _update_status(self, data: dict):
        """상태 데이터로 우측 패널 갱신."""
        # Connection
        connected = data.get("connected", {})
        if connected.get("standx"):
            self._lbl_standx_conn.configure(text="연결됨", style="Connected.TLabel")
        else:
            self._lbl_standx_conn.configure(text="미연결", style="Disconnected.TLabel")

        if connected.get("decibel"):
            self._lbl_decibel_conn.configure(text="연결됨", style="Connected.TLabel")
        else:
            self._lbl_decibel_conn.configure(text="미연결", style="Disconnected.TLabel")

        # Positions
        positions = data.get("positions", {})
        s_pos = positions.get("standx")
        d_pos = positions.get("decibel")

        if s_pos and isinstance(s_pos, dict):
            side = s_pos.get("side", "none")
            qty = s_pos.get("qty", s_pos.get("position_qty", "0"))
            self._lbl_standx_pos.configure(text=f"{side.upper()} {qty}")
        else:
            self._lbl_standx_pos.configure(text="없음")

        if d_pos and isinstance(d_pos, dict):
            side = d_pos.get("side", "none")
            qty = d_pos.get("qty", d_pos.get("position_qty", "0"))
            self._lbl_decibel_pos.configure(text=f"{side.upper()} {qty}")
        else:
            self._lbl_decibel_pos.configure(text="없음")

        # Bot status
        running = data.get("running", False)
        cycle = data.get("cycle", 0)

        if running:
            self._lbl_bot_status.configure(text="실행 중", style="Running.TLabel")
        else:
            self._lbl_bot_status.configure(text="정지", style="Stopped.TLabel")
            # 봇이 외부에서 정지된 경우 버튼 상태 복원
            if self._polling:
                self._polling = False
                self._btn_start.configure(state="normal")
                self._btn_stop.configure(state="disabled")

        self._lbl_cycle.configure(text=str(cycle))

        # Error
        error = data.get("error", "")
        self._lbl_error.configure(text=error if error else "없음")

        # Logs — 새 로그만 추가 (서버 재시작 시 리셋 감지)
        logs = data.get("logs", [])
        if logs:
            if len(logs) < self._prev_log_count:
                self._prev_log_count = 0
            new_logs = logs[self._prev_log_count:]
            self._prev_log_count = len(logs)
            for line in new_logs:
                self._append_log(line)

    # ── Log ──────────────────────────────────────────────────

    def _append_log(self, text: str):
        """로그 텍스트 위젯에 한 줄 추가 (최대 MAX_LOG_LINES 유지)."""
        self._txt_log.configure(state=tk.NORMAL)
        self._txt_log.insert(tk.END, text.rstrip() + "\n")

        # 줄 수 제한
        line_count = int(self._txt_log.index("end-1c").split(".")[0])
        if line_count > MAX_LOG_LINES:
            self._txt_log.delete("1.0", f"{line_count - MAX_LOG_LINES}.0")

        self._txt_log.see(tk.END)
        self._txt_log.configure(state=tk.DISABLED)

    # ── Shutdown ─────────────────────────────────────────────

    def on_close(self):
        """종료: 폴링 중지, 서버 프로세스 kill."""
        self._polling = False

        if self._server_proc and self._server_proc.poll() is None:
            try:
                if self._server_proc.stdout:
                    self._server_proc.stdout.close()
                if sys.platform == "win32":
                    self._server_proc.terminate()
                else:
                    os.kill(self._server_proc.pid, signal.SIGTERM)
                self._server_proc.wait(timeout=5)
            except (subprocess.TimeoutExpired, ProcessLookupError, OSError):
                try:
                    self._server_proc.kill()
                except Exception:
                    pass

        self.root.destroy()


# ── Entry Point ──────────────────────────────────────────────

def main():
    root = tk.Tk()
    app = HedgeBotGUI(root)
    root.protocol("WM_DELETE_WINDOW", app.on_close)
    root.mainloop()


if __name__ == "__main__":
    main()
