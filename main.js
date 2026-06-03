// ============================================================
// ������ 共读书架 v4.0 - 分页阅读、实时笔记、翻页同步
// ============================================================

function safeName(name) {
    return name.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').substring(0, 60) || 'unnamed';
}

function padNo(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
}

function nowStr() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function progressStr(current, total) {
    if (!total) return '第 0/0 章';
    return '第 ' + current + '/' + total + ' 章（' + (current / total * 100).toFixed(1) + '%）';
}

// ── PDF文本提取 ────────────────────────────────────────────

function extractTextFromPdf(data) {
    var raw = data;
    if (/^[A-Za-z0-9+/=\s]+$/.test(raw.trim().substring(0, 100)) && raw.length > 100) {
        try { raw = atob(raw.trim()); } catch (e) {}
    }
    var textParts = [];
    var streamRegex = /stream\r?\n?([\s\S]*?)endstream/g;
    var match;
    while ((match = streamRegex.exec(raw)) !== null) {
        var sc = match[1];
        var tjRegex = /\(([^)]*)\)\s*Tj/g;
        var tjMatch;
        while ((tjMatch = tjRegex.exec(sc)) !== null) {
            if (tjMatch[1] && tjMatch[1].trim()) textParts.push(tjMatch[1]);
        }
        var tjArrRegex = /\[[^\]]*\]\s*TJ/g;
        var tjArrMatch;
        while ((tjArrMatch = tjArrRegex.exec(sc)) !== null) {
            var arrC = tjArrMatch[1];
            var strRe = /\(([^)]*)\)/g;
            var strMatch, lineParts = [];
            while ((strMatch = strRe.exec(arrC)) !== null) {
                if (strMatch[1]) lineParts.push(strMatch[1]);
            }
            if (lineParts.length > 0) textParts.push(lineParts.join(''));
        }
    }
    if (textParts.length === 0) {
        var bRegex = /\(([\\x20-\\x7E\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]{2,})\)/g;
        var bMatch;
        while ((bMatch = bRegex.exec(raw)) !== null) {
            var c = bMatch[1];
            if (!/^(PDF|Font|Type|Resource|MediaBox|ProcSet|Encoding|Width|Height|Length|Filter|Subtype|BaseFont)/.test(c)) textParts.push(c);
        }
    }
    var result = textParts.join('\\n');
    return result.replace(/\\n/g, '\\n').replace(/\\r/g, '\\r').replace(/\\t/g, '\\t').replace(/\\\\(/g, '(').replace(/\\\\)/g, ')').replace(/\\\\\\\\/g, '\\\\').trim();
}

function isPdfContent(content, fileName) {
    if (fileName && /\\.pdf$/i.test(fileName)) return true;
    var data = typeof content === 'string' ? content : (content && (content.content || content.data || ''));
    if (typeof data === 'string' && data.indexOf('%PDF') === 0) return true;
    if (typeof data === 'string' && data.trim().indexOf('JVBERi') === 0) return true;
    return false;
}

function extractFileContent(params) {
    var raw = params.content;
    var fileName = params.name || params.fileName || '';
    var text = '';
    var isPdf = isPdfContent(raw, fileName);
    if (typeof raw === 'string') {
        text = isPdf ? extractTextFromPdf(raw) : raw;
    } else if (raw && typeof raw === 'object') {
        var dataField = raw.content || raw.text || raw.data || raw.body || raw.buffer || raw.value || '';
        var mimeType = raw.mimeType || raw.type || raw.contentType || '';
        if (typeof dataField === 'string') {
            isPdf = isPdf || mimeType === 'application/pdf' || /\\.pdf$/i.test(raw.name || fileName);
            text = isPdf ? extractTextFromPdf(dataField) : dataField;
        } else {
            try { text = JSON.stringify(raw); } catch (e) { text = String(raw); }
        }
    } else {
        text = String(raw || '');
    }
    return text;
}

// ── 章节分割 ─────────────────────────────────────────────────

var RE_CHAPTER_LINE = /^[\\s\\u3000]*(第\\s*[零一二三四五六七八九十百千万\\u96F6\\u3007\\d]+\\s*[章节卷回篇][^\\n]*|Chapter\\s+\\d+[^\\n]*)[\\s\\u3000]*$/i;

function splitChapters(text) {
    text = text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    if (!text) return [];
    var lines = text.split('\\n');
    var chapterStarts = [];
    for (var i = 0; i < lines.length; i++) {
        if (RE_CHAPTER_LINE.test(lines[i])) {
            chapterStarts.push({ lineIdx: i, title: lines[i].trim() });
        }
    }
    var chapters = [];
    if (chapterStarts.length > 0) {
        for (var c = 0; c < chapterStarts.length; c++) {
            var startLine = chapterStarts[c].lineIdx + 1;
            var endLine = (c + 1 < chapterStarts.length) ? chapterStarts[c + 1].lineIdx : lines.length;
            var body = lines.slice(startLine, endLine).join('\\n').trim();
            chapters.push({ title: chapterStarts[c].title, content: body || '（本章正文为空）' });
        }
    } else {
        var CHUNK = 3000;
        for (var j = 0; j < text.length; j += CHUNK) {
            var chunk = text.substring(j, j + CHUNK).trim();
            if (chunk) chapters.push({ title: '第 ' + (chapters.length + 1) + ' 章', content: chunk });
        }
    }
    return chapters;
}

// ── 分页功能 ─────────────────────────────────────────────────

var CHARS_PER_PAGE = 800;

function splitPages(content) {
    var pages = [];
    var paragraphs = content.split('\\n');
    var currentPage = '';
    var currentLen = 0;
    
    for (var i = 0; i < paragraphs.length; i++) {
        var p = paragraphs[i].trim();
        if (!p) continue;
        
        if (currentLen + p.length > CHARS_PER_PAGE && currentPage) {
            pages.push(currentPage.trim());
            currentPage = p + '\\n\\n';
            currentLen = p.length;
        } else {
            currentPage += p + '\\n\\n';
            currentLen += p.length;
        }
    }
    
    if (currentPage.trim()) {
        pages.push(currentPage.trim());
    }
    
    return pages.length > 0 ? pages : ['(空章节)'];
}

function getChapterPages(bookName, chapterNo) {
    var safe = safeName(bookName);
    var pagesKey = 'book_pages_' + safe + '_' + padNo(chapterNo);
    var pagesStr = dataStore.get(pagesKey);
    if (pagesStr) {
        try { return JSON.parse(pagesStr); } catch (e) {}
    }
    return null;
}

function saveChapterPages(bookName, chapterNo, pages) {
    var safe = safeName(bookName);
    var pagesKey = 'book_pages_' + safe + '_' + padNo(chapterNo);
    dataStore.set(pagesKey, JSON.stringify({ chapterNo: chapterNo, totalPages: pages.length, pages: pages }));
}

// ── 导入书籍 ───────────────────────────────────────────────

function import_book(params) {
    try {
        var name = String(params.name || '').trim();
        if (!name) return { success: false, error: '书名不能为空' };
        var content = extractFileContent(params);
        if (!content.trim()) return { success: false, error: '文件内容为空' };
        var safe = safeName(name);
        
        var existIdxStr = dataStore.get('book_idx_' + safe);
        if (existIdxStr) {
            try {
                var oldIdx = JSON.parse(existIdxStr);
                for (var i = 1; i <= oldIdx.totalChapters; i++) {
                    dataStore.del('book_ch_' + safe + '_' + padNo(i));
                    dataStore.del('book_pages_' + safe + '_' + padNo(i));
                }
            } catch (e) {}
            dataStore.del('book_idx_' + safe);
        }
        
        var chapters = splitChapters(content);
        if (chapters.length === 0) return { success: false, error: '无法解析章节' };
        
        for (var c = 0; c < chapters.length; c++) {
            dataStore.set('book_ch_' + safe + '_' + padNo(c + 1), JSON.stringify({ no: c + 1, title: chapters[c].title, content: chapters[c].content }));
            var pages = splitPages(chapters[c].content);
            saveChapterPages(name, c + 1, pages);
        }
        
        var idxObj = { name: name, safeName: safe, totalChapters: chapters.length, currentChapter: 1, currentPage: 1, progress: progressStr(1, chapters.length), totalChaptersTag: chapters.length + ' 章', createdAt: nowStr(), updatedAt: nowStr() };
        dataStore.set('book_idx_' + safe, JSON.stringify(idxObj));
        
        if (!dataStore.get('book_notes_' + safe)) dataStore.set('book_notes_' + safe, '[]');
        if (!dataStore.get('book_thoughts_' + safe)) dataStore.set('book_thoughts_' + safe, '[]');
        
        return { success: true, name: name, totalChapters: chapters.length };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function list_books() {
    try {
        var keys = dataStore.list('book_idx_');
        var books = [];
        for (var i = 0; i < keys.length; i++) {
            var val = dataStore.get(keys[i]);
            if (val) {
                try {
                    var idx = JSON.parse(val);
                    books.push({ name: idx.name, totalChapters: idx.totalChapters, currentChapter: idx.currentChapter, currentPage: idx.currentPage || 1, progress: idx.progress || progressStr(idx.currentChapter, idx.totalChapters), totalChaptersTag: idx.totalChaptersTag || (idx.totalChapters + ' 章'), updatedAt: idx.updatedAt });
                } catch (e) {}
            }
        }
        books.sort(function(a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
        return { success: true, books: books, count: books.length };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function get_toc(params) {
    try {
        var name = String(params.book_name || '').trim();
        if (!name) return { success: false, error: 'book_name required' };
        var safe = safeName(name);
        var idxStr = dataStore.get('book_idx_' + safe);
        if (!idxStr) return { success: false, error: 'Book not found: ' + name };
        var idx = JSON.parse(idxStr);
        var toc = [];
        for (var i = 1; i <= idx.totalChapters; i++) {
            var chStr = dataStore.get('book_ch_' + safe + '_' + padNo(i));
            if (chStr) {
                try {
                    var ch = JSON.parse(chStr);
                    var pages = getChapterPages(name, i);
                    toc.push({ no: i, title: ch.title, chars: ch.content.length, pages: pages ? pages.totalPages : 1 });
                } catch (e) {}
            }
        }
        return { success: true, name: name, totalChapters: idx.totalChapters, toc: toc };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function get_chapter(params) {
    try {
        var name = String(params.book_name || '').trim();
        var no = parseInt(params.chapter_no, 10);
        if (!name) return { success: false, error: 'book_name required' };
        if (isNaN(no) || no < 1) return { success: false, error: 'invalid chapter_no' };
        var safe = safeName(name);
        var idxStr = dataStore.get('book_idx_' + safe);
        if (!idxStr) return { success: false, error: 'Book not found: ' + name };
        var idx = JSON.parse(idxStr);
        if (no > idx.totalChapters) return { success: false, error: 'Chapter not found' };
        var chStr = dataStore.get('book_ch_' + safe + '_' + padNo(no));
        if (!chStr) return { success: false, error: 'Chapter data lost' };
        var ch = JSON.parse(chStr);
        idx.currentChapter = no;
        idx.currentPage = 1;
        idx.updatedAt = nowStr();
        idx.progress = progressStr(no, idx.totalChapters);
        dataStore.set('book_idx_' + safe, JSON.stringify(idx));
        return { success: true, name: name, chapterNo: no, title: ch.title, content: ch.content, totalChapters: idx.totalChapters, hasNext: no < idx.totalChapters, hasPrev: no > 1 };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

// ── 分页读取 ───────────────────────────────────────────────

function get_page(params) {
    try {
        var name = String(params.book_name || '').trim();
        var chapterNo = parseInt(params.chapter_no, 10);
        var pageNo = parseInt(params.page_no, 10);
        if (!name) return { success: false, error: 'book_name required' };
        if (isNaN(chapterNo) || chapterNo < 1) return { success: false, error: 'invalid chapter_no' };
        if (isNaN(pageNo) || pageNo < 1) return { success: false, error: 'invalid page_no' };
        
        var safe = safeName(name);
        var idxStr = dataStore.get('book_idx_' + safe);
        if (!idxStr) return { success: false, error: 'Book not found' };
        var idx = JSON.parse(idxStr);
        
        var pagesData = getChapterPages(name, chapterNo);
        if (!pagesData) {
            var chStr = dataStore.get('book_ch_' + safe + '_' + padNo(chapterNo));
            if (!chStr) return { success: false, error: 'Chapter not found' };
            var ch = JSON.parse(chStr);
            var pages = splitPages(ch.content);
            saveChapterPages(name, chapterNo, pages);
            pagesData = { totalPages: pages.length, pages: pages };
        }
        
        if (pageNo > pagesData.totalPages) return { success: false, error: 'Page not found, total: ' + pagesData.totalPages };
        
        idx.currentChapter = chapterNo;
        idx.currentPage = pageNo;
        idx.updatedAt = nowStr();
        dataStore.set('book_idx_' + safe, JSON.stringify(idx));
        
        return { success: true, name: name, chapterNo: chapterNo, pageNo: pageNo, totalPages: pagesData.totalPages, content: pagesData.pages[pageNo - 1], hasNext: pageNo < pagesData.totalPages, hasPrev: pageNo > 1 };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function get_progress(params) {
    try {
        var name = String(params.book_name || '').trim();
        if (!name) return { success: false, error: 'book_name required' };
        var safe = safeName(name);
        var idxStr = dataStore.get('book_idx_' + safe);
        if (!idxStr) return { success: false, error: 'Book not found' };
        var idx = JSON.parse(idxStr);
        var pct = idx.totalChapters > 0 ? (idx.currentChapter / idx.totalChapters * 100).toFixed(1) : '0.0';
        return { success: true, name: name, currentChapter: idx.currentChapter, currentPage: idx.currentPage || 1, totalChapters: idx.totalChapters, percentage: pct, progress: progressStr(idx.currentChapter, idx.totalChapters), lastRead: idx.updatedAt };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function set_progress(params) {
    try {
        var name = String(params.book_name || '').trim();
        var no = parseInt(params.chapter_no, 10);
        if (!name) return { success: false, error: 'book_name required' };
        if (isNaN(no) || no < 1) return { success: false, error: 'invalid chapter_no' };
        var safe = safeName(name);
        var idxStr = dataStore.get('book_idx_' + safe);
        if (!idxStr) return { success: false, error: 'Book not found' };
        var idx = JSON.parse(idxStr);
        if (no > idx.totalChapters) return { success: false, error: 'Out of range' };
        idx.currentChapter = no;
        idx.currentPage = 1;
        idx.updatedAt = nowStr();
        idx.progress = progressStr(no, idx.totalChapters);
        dataStore.set('book_idx_' + safe, JSON.stringify(idx));
        return { success: true, name: name, currentChapter: no };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function delete_book(params) {
    try {
        var name = String(params.book_name || params.name || '').trim();
        if (!name) return { success: false, error: 'book_name required' };
        var safe = safeName(name);
        var idxStr = dataStore.get('book_idx_' + safe);
        if (!idxStr) return { success: false, error: 'Book not found' };
        var idx = JSON.parse(idxStr);
        for (var i = 1; i <= idx.totalChapters; i++) {
            dataStore.del('book_ch_' + safe + '_' + padNo(i));
            dataStore.del('book_pages_' + safe + '_' + padNo(i));
        }
        dataStore.del('book_idx_' + safe);
        dataStore.del('book_notes_' + safe);
        dataStore.del('book_thoughts_' + safe);
        return { success: true, name: name };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function add_note(params) {
    try {
        var name = String(params.book_name || '').trim();
        var no = parseInt(params.chapter_no, 10);
        var content = String(params.content || '').trim();
        if (!name) return { success: false, error: 'book_name required' };
        if (isNaN(no) || no < 1) return { success: false, error: 'invalid chapter_no' };
        if (!content) return { success: false, error: 'note content empty' };
        var safe = safeName(name);
        if (!dataStore.get('book_idx_' + safe)) return { success: false, error: 'Book not found' };
        var notesStr = dataStore.get('book_notes_' + safe);
        var notes = notesStr ? JSON.parse(notesStr) : [];
        notes.push({ chapter: no, content: content, time: nowStr() });
        dataStore.set('book_notes_' + safe, JSON.stringify(notes));
        return { success: true, name: name, chapter: no, noteIndex: notes.length };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function get_notes(params) {
    try {
        var name = String(params.book_name || '').trim();
        var no = params.chapter_no != null ? parseInt(params.chapter_no, 10) : null;
        if (!name) return { success: false, error: 'book_name required' };
        var safe = safeName(name);
        if (!dataStore.get('book_idx_' + safe)) return { success: false, error: 'Book not found' };
        var notesStr = dataStore.get('book_notes_' + safe);
        var notes = notesStr ? JSON.parse(notesStr) : [];
        if (no !== null && !isNaN(no)) notes = notes.filter(function(n) { return n.chapter === no; });
        return { success: true, name: name, notes: notes.slice(-50), count: notes.length };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function add_thought(params) {
    try {
        var name = String(params.book_name || '').trim();
        var no = parseInt(params.chapter_no, 10);
        var content = String(params.content || '').trim();
        if (!name) return { success: false, error: 'book_name required' };
        if (isNaN(no) || no < 1) return { success: false, error: 'invalid chapter_no' };
        if (!content) return { success: false, error: 'thought content empty' };
        var safe = safeName(name);
        if (!dataStore.get('book_idx_' + safe)) return { success: false, error: 'Book not found' };
        var tStr = dataStore.get('book_thoughts_' + safe);
        var thoughts = tStr ? JSON.parse(tStr) : [];
        thoughts.push({ chapter: no, content: content, time: nowStr() });
        dataStore.set('book_thoughts_' + safe, JSON.stringify(thoughts));
        return { success: true, name: name, chapter: no, thoughtIndex: thoughts.length };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function get_thoughts(params) {
    try {
        var name = String(params.book_name || '').trim();
        var no = params.chapter_no != null ? parseInt(params.chapter_no, 10) : null;
        if (!name) return { success: false, error: 'book_name required' };
        var safe = safeName(name);
        if (!dataStore.get('book_idx_' + safe)) return { success: false, error: 'Book not found' };
        var tStr = dataStore.get('book_thoughts_' + safe);
        var thoughts = tStr ? JSON.parse(tStr) : [];
        if (no !== null && !isNaN(no)) thoughts = thoughts.filter(function(t) { return t.chapter === no; });
        return { success: true, name: name, thoughts: thoughts.slice(-50), count: thoughts.length };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function shared_panel(params) {
    try {
        var name = String(params.book_name || '').trim();
        if (!name) return { success: false, error: 'book_name required' };
        var safe = safeName(name);
        var idxStr = dataStore.get('book_idx_' + safe);
        if (!idxStr) return { success: false, error: 'Book not found' };
        var idx = JSON.parse(idxStr);
        var notesStr = dataStore.get('book_notes_' + safe);
        var notes = notesStr ? JSON.parse(notesStr) : [];
        var tStr = dataStore.get('book_thoughts_' + safe);
        var thoughts = tStr ? JSON.parse(tStr) : [];
        var nextCh = Math.min(idx.currentChapter + 1, idx.totalChapters);
        var lastNote = notes.length > 0 ? notes[notes.length - 1] : null;
        var pct = idx.totalChapters > 0 ? (idx.currentChapter / idx.totalChapters * 100).toFixed(1) : '0.0';
        return { success: true, name: name, currentChapter: idx.currentChapter, currentPage: idx.currentPage || 1, totalChapters: idx.totalChapters, percentage: pct, progress: progressStr(idx.currentChapter, idx.totalChapters), noteCount: notes.length, thoughtCount: thoughts.length, lastNote: lastNote, nextChapter: nextCh, suggestion: idx.currentChapter < idx.totalChapters ? '继续阅读第 ' + nextCh + ' 章' : '已读完全书！' };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

// ── 共读模式 ───────────────────────────────────────────────

function read_with_me(params) {
    try {
        var name = String(params.book_name || '').trim();
        var safe = safeName(name);
        var idxStr = dataStore.get('book_idx_' + safe);
        if (!idxStr) return { success: false, error: 'Book not found, please import first' };
        var idx = JSON.parse(idxStr);
        
        var chapterNo = params.chapter_no != null ? parseInt(params.chapter_no, 10) : idx.currentChapter;
        var pageNo = params.page_no != null ? parseInt(params.page_no, 10) : (idx.currentPage || 1);
        
        if (isNaN(chapterNo) || chapterNo < 1) chapterNo = 1;
        if (isNaN(pageNo) || pageNo < 1) pageNo = 1;
        if (chapterNo > idx.totalChapters) return { success: false, error: 'Already at the last chapter' };
        
        var pageData = get_page({ book_name: name, chapter_no: chapterNo, page_no: pageNo });
        if (!pageData.success) return pageData;
        
        var notesStr = dataStore.get('book_notes_' + safe);
        var notes = notesStr ? JSON.parse(notesStr) : [];
        var chapterNotes = notes.filter(function(n) { return n.chapter === chapterNo; });
        
        return { success: true, name: name, chapterNo: chapterNo, pageNo: pageNo, totalPages: pageData.totalPages, content: pageData.content, hasNextPage: pageData.hasNext, hasPrevPage: pageData.hasPrev, existingNotes: chapterNotes, instruction: 'Read the page above, then write a preview note starting with [老公] using add_note.' };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function reply_note(params) {
    try {
        var name = String(params.book_name || '').trim();
        var no = parseInt(params.chapter_no, 10);
        var noteIdx = parseInt(params.note_index, 10);
        var content = String(params.content || '').trim();
        if (!name) return { success: false, error: 'book_name required' };
        if (isNaN(no) || no < 1) return { success: false, error: 'invalid chapter_no' };
        if (isNaN(noteIdx) || noteIdx < 1) return { success: false, error: 'invalid note_index' };
        if (!content) return { success: false, error: 'reply content empty' };
        var safe = safeName(name);
        if (!dataStore.get('book_idx_' + safe)) return { success: false, error: 'Book not found' };
        var notesStr = dataStore.get('book_notes_' + safe);
        var notes = notesStr ? JSON.parse(notesStr) : [];
        notes.push({ chapter: no, content: 'Reply to note#' + noteIdx + ': ' + content, time: nowStr(), replyTo: noteIdx });
        dataStore.set('book_notes_' + safe, JSON.stringify(notes));
        return { success: true, name: name, chapter: no, noteIndex: notes.length, replyTo: noteIdx };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

// ── 导出 ────────────────────────────────────────────────────

exports.import_book = import_book;
exports.list_books = list_books;
exports.get_toc = get_toc;
exports.get_chapter = get_chapter;
exports.get_page = get_page;
exports.get_progress = get_progress;
exports.set_progress = set_progress;
exports.delete_book = delete_book;
exports.add_note = add_note;
exports.get_notes = get_notes;
exports.add_thought = add_thought;
exports.get_thoughts = get_thoughts;
exports.shared_panel = shared_panel;
exports.read_with_me = read_with_me;
exports.reply_note = reply_note;