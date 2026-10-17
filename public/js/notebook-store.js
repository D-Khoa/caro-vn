/**
 * Quản lý Quyển Vở Ô Ly 200 Trang bằng IndexedDB (kèm fallback LocalStorage)
 * Lưu trữ toàn bộ các ván cờ đã kết thúc, đường viền khoanh vùng điểm chết, và ván đang chơi trên từng trang.
 */

import { TOTAL_NOTEBOOK_PAGES, BOARD_ROWS, BOARD_COLS } from './rules.js';

const DB_NAME = 'CaroVoOLyVN_DB';
const DB_VERSION = 1;
const STORE_PAGES = 'pages';
const PROFILE_KEY = 'caro_vn_student_profile_v1';

export class NotebookStore {
  constructor() {
    this.db = null;
    this.memoryCache = new Map();
    this.totalCellsPerPage = BOARD_ROWS * BOARD_COLS;
  }

  async init() {
    if (this.db) return;
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_PAGES)) {
            db.createObjectStore(STORE_PAGES, { keyPath: 'pageNumber' });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });

      // Nạp tất cả các trang đã từng viết vào bộ nhớ đệm để lật trang 0ms
      const allSavedPages = await this._getAllFromIDB();
      for (const p of allSavedPages) {
        this.memoryCache.set(p.pageNumber, p);
      }
    } catch (err) {
      console.warn('IndexedDB không khả dụng, chuyển sang chế độ bộ nhớ tạm + LocalStorage:', err);
      this._loadFromLocalStorageFallback();
    }
  }

  _getAllFromIDB() {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction(STORE_PAGES, 'readonly');
      const store = tx.objectStore(STORE_PAGES);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  _loadFromLocalStorageFallback() {
    try {
      const raw = localStorage.getItem('caro_vn_pages_fallback');
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const p of parsed) {
          this.memoryCache.set(p.pageNumber, p);
        }
      }
    } catch (_) {
      // Ignore
    }
  }

  _saveToLocalStorageFallback() {
    try {
      const arr = Array.from(this.memoryCache.values());
      localStorage.setItem('caro_vn_pages_fallback', JSON.stringify(arr));
    } catch (_) {
      // Ignore quota errors
    }
  }

  formatVietnameseDate(timestamp = Date.now()) {
    const d = new Date(timestamp);
    const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
    const dayName = days[d.getDay()];
    const date = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${dayName}, ngày ${date} tháng ${month} năm ${year}`;
  }

  createBlankPage(pageNumber) {
    return {
      pageNumber,
      dateHeader: this.formatVietnameseDate(),
      archivedGames: [],
      activeGame: null,
      updatedAt: Date.now()
    };
  }

  async getPage(pageNumber) {
    const num = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(pageNumber) || 1));
    if (this.memoryCache.has(num)) {
      return structuredClone(this.memoryCache.get(num));
    }
    const blank = this.createBlankPage(num);
    return blank;
  }

  async savePage(pageData) {
    pageData.updatedAt = Date.now();
    const cloned = structuredClone(pageData);
    this.memoryCache.set(cloned.pageNumber, cloned);

    if (this.db) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(STORE_PAGES, 'readwrite');
        const store = tx.objectStore(STORE_PAGES);
        const req = store.put(cloned);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } else {
      this._saveToLocalStorageFallback();
    }
  }

  async clearPage(pageNumber) {
    const num = Math.max(1, Math.min(TOTAL_NOTEBOOK_PAGES, Number(pageNumber) || 1));
    const blank = this.createBlankPage(num);
    this.memoryCache.delete(num);

    if (this.db) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(STORE_PAGES, 'readwrite');
        const store = tx.objectStore(STORE_PAGES);
        const req = store.delete(num);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } else {
      this._saveToLocalStorageFallback();
    }
    return blank;
  }

  /**
   * Trả về thông tin tổng hợp của cả 200 trang vở để hiển thị Mục Lục
   */
  getNotebookOverview() {
    const pages = [];
    let totalFinishedGames = 0;
    let usedPagesCount = 0;

    for (let i = 1; i <= TOTAL_NOTEBOOK_PAGES; i++) {
      const p = this.memoryCache.get(i);
      if (!p || (p.archivedGames.length === 0 && (!p.activeGame || p.activeGame.moves.length === 0))) {
        pages.push({
          pageNumber: i,
          gamesCount: 0,
          hasActiveGame: false,
          usedRatio: 0,
          status: 'empty'
        });
      } else {
        const deadSet = new Set();
        for (const g of p.archivedGames) {
          for (const cell of g.deadCells || []) {
            deadSet.add(cell);
          }
        }
        const activeMovesCount = p.activeGame?.moves?.length || 0;
        const usedRatio = Math.min(100, Math.round(((deadSet.size + activeMovesCount) / this.totalCellsPerPage) * 100));
        totalFinishedGames += p.archivedGames.length;
        usedPagesCount++;

        pages.push({
          pageNumber: i,
          gamesCount: p.archivedGames.length,
          hasActiveGame: activeMovesCount > 0,
          usedRatio,
          status: usedRatio >= 85 ? 'full' : 'used',
          updatedAt: p.updatedAt
        });
      }
    }

    return {
      totalPages: TOTAL_NOTEBOOK_PAGES,
      usedPagesCount,
      totalFinishedGames,
      pages
    };
  }

  getPlayerProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (_) {}

    const randomId = Math.floor(1000 + Math.random() * 9000);
    const defaultProfile = {
      name: `Học Sinh #${randomId}`,
      school: 'THPT Chuyên Caro Việt Nam',
      className: '12A1',
      schoolYear: '2026 - 2027',
      currentPage: 1,
      stats: {
        wins: 0,
        losses: 0,
        draws: 0,
        highestAiBeaten: 0
      }
    };
    this.savePlayerProfile(defaultProfile);
    return defaultProfile;
  }

  savePlayerProfile(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch (_) {}
  }

  exportNotebookJSON() {
    const payload = {
      app: 'CaroVoOLyVN',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: this.getPlayerProfile(),
      pages: Array.from(this.memoryCache.values())
    };
    return JSON.stringify(payload, null, 2);
  }

  async importNotebookJSON(jsonString) {
    const data = JSON.parse(jsonString);
    if (!data || data.app !== 'CaroVoOLyVN' || !Array.isArray(data.pages)) {
      throw new Error('File quyển vở không hợp lệ!');
    }
    if (data.profile) {
      this.savePlayerProfile(data.profile);
    }
    for (const page of data.pages) {
      if (page.pageNumber >= 1 && page.pageNumber <= TOTAL_NOTEBOOK_PAGES) {
        await this.savePage(page);
      }
    }
    return true;
  }
}
