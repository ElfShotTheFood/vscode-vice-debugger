/**
 * Shared webview-side edit widgets for VICE debugger panels.
 *
 * This file exports the source of the widget bundle as a string constant.
 * ViceWebviewPanel._wrapHtml() injects it into every panel's webview before
 * the panel-specific script, so all edit boxes across the Registers, Memory,
 * and Disassembly windows share one implementation and one set of styles.
 *
 * The bundle defines:
 *   - EDIT_VALUE_KIND: symbolic constants for the type of value an edit box
 *     edits ('hex', 'decimal', 'binary', 'text'); the kind selects the
 *     per-keystroke pattern, the text->value parser, and the display format.
 *   - EditBox:       editor wrapping a real <input> element (native caret).
 *   - InPlaceEditBox: editor that takes over an existing span and edits it
 *     in place with a blinking block cursor (inverted character).
 */
export const EDIT_BOX_SCRIPT = `
// What kind of value an edit box edits.  The kind selects the legal input
// characters (per-keystroke validation), how the typed text is parsed into a
// value on commit, and how a value is displayed in the box.
var EDIT_VALUE_KIND = {
	HEX: 'hex',         // e.g. $0A; typed text is parsed as hex
	DECIMAL: 'decimal', // e.g. 16; typed text is parsed as decimal
	BINARY: 'binary',   // e.g. 0 or 1 (status flag bits)
	TEXT: 'text'        // free-form printable text (no numeric value)
};

// Per-keystroke legality for each kind.  null = any printable character.
var KIND_PATTERNS = {
	hex: '^[0-9a-fA-F]$',
	decimal: '^[0-9]$',
	binary: '^[01]$',
	text: null
};

// Text -> value parsing for each kind (used on commit).
var KIND_PARSERS = {
	hex: function (text) {
		var t = String(text).trim();
		if (t.charAt(0) === '$') { t = t.slice(1); }
		else if (/^0x/i.test(t)) { t = t.slice(2); }
		if (!/^[0-9a-fA-F]+$/.test(t)) { return NaN; }
		return parseInt(t, 16);
	},
	decimal: function (text) {
		var t = String(text).trim();
		if (!/^[0-9]+$/.test(t)) { return NaN; }
		return parseInt(t, 10);
	},
	binary: function (text) {
		var t = String(text).trim();
		return t === '1' ? 1 : (t === '0' ? 0 : NaN);
	},
	text: function (text) { return String(text); }
};

// Value -> display text for each kind (used by setValue/restore and after
// a successful commit).
var KIND_FORMATTERS = {
	hex: function (value, width) {
		return (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
	},
	decimal: function (value) { return String(value); },
	binary: function (value) { return String(value); },
	text: function (value) { return String(value); }
};

var DEFAULT_BLINK_RATE = 350; // ms per blink phase

// All live input-based EditBox instances in this webview, plus the one-time
// installation of a document-level mouse-down handler that makes clicking
// outside any edit box equivalent to hitting ESC: the active editor is
// cancelled (edits discarded, original value restored) before focus moves.
// A click that lands inside an edit box is left alone, so that box simply
// receives focus and starts editing.
var _viceEditBoxes = [];
var _viceOutsideClickInstalled = false;
function _viceEnsureOutsideClickCancel() {
	if (_viceOutsideClickInstalled) { return; }
	_viceOutsideClickInstalled = true;
	document.addEventListener('mousedown', function (e) {
		// Prune widgets whose inputs were removed from the DOM (e.g. by a
		// panel re-render) so the registry does not grow unbounded.
		_viceEditBoxes = _viceEditBoxes.filter(function (box) {
			return document.body.contains(box._el);
		});
		// Is the click inside any edit box (or an in-place span editor)?
		var node = e.target;
		while (node) {
			if (node === document.body) { break; }
			if ((node.tagName === 'INPUT' && node.type === 'text') ||
				(node.classList && node.classList.contains('vice-block-cursor'))) {
				return; // click within an edit box: let it start editing
			}
			node = node.parentNode;
		}
		// Click outside any edit box: cancel every active editor (ESC).
		_viceEditBoxes.forEach(function (box) {
			if (box._hasFocus) { box.cancel(); }
		});
	});
}

// Text-extent measurement (the DOM equivalent of GetTextExtent): measure the
// rendered width of a character with the same font the element uses, via a
// canvas 2D context.  The editor font is monospace, so one '0' gives the
// per-character cell width used to size edit boxes and place block cursors.
var _viceMeasureCanvas = null;
function measureTextExtent(text, fontStyle) {
	if (!_viceMeasureCanvas) { _viceMeasureCanvas = document.createElement('canvas'); }
	var ctx = _viceMeasureCanvas.getContext('2d');
	ctx.font = fontStyle;
	return ctx.measureText(text).width;
}

function computedFontStyle() {
	// Measure with the document's font (the body resolves the editor font
	// CSS variables).  Computed styles on *detached* elements (inputs not
	// yet added to the table) fall back to browser defaults, so measuring
	// the element itself gives wrong extents during widget construction.
	var s = getComputedStyle(document.body);
	var size = s.fontSize || '13px';
	var family = s.fontFamily || 'monospace';
	return size + ' ' + family;
}

// Base class: shared options, parse/format/validate, and the commit/cancel
// protocol.  width is in hex digits (2 = byte, 4 = word/address).  valueKind
// ('hex', 'decimal', 'binary', 'text') drives the per-keystroke pattern, the
// text->value parser, and the value->display formatter; explicit parse/format
// overrides in options still take precedence when supplied.
class EditBoxBase {
	constructor(options) {
		this._opts = Object.assign({
			width: 2,
			valueKind: EDIT_VALUE_KIND.HEX,
			overstrike: true,
			replaceWholeOnType: false,
			blinkRate: DEFAULT_BLINK_RATE,
			parse: null,
			format: null,
			validator: null,
			onCommit: null,
			onCancel: null
		}, options || {});
		this._value = null;
	}
	_pattern() { return KIND_PATTERNS[this._opts.valueKind] || null; }
	_format(v) { return this._opts.format ? this._opts.format(v) : KIND_FORMATTERS[this._opts.valueKind](v, this._opts.width); }
	_parse(text) { return this._opts.parse ? this._opts.parse(text) : KIND_PARSERS[this._opts.valueKind](text); }
	_isValid(v) { return !isNaN(v) && (!this._opts.validator || this._opts.validator(v)); }
	_canAcceptKey(e) {
		if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) { return false; }
		var pattern = this._pattern();
		return pattern === null || new RegExp(pattern).test(e.key);
	}
	setValue(v) { this._value = v; this._setValueText(this._format(v)); }
	getValue() { return this._value; }
	restore() { this._setValueText(this._format(this._value)); }
}

// Editor for real <input> elements.  The input is sized to the exact text
// extent of the rendered font (charWidth * width, zero padding), and the
// native caret is replaced by a blinking block cursor overlay that inverts
// the digit under it.  Enter commits and ends the edit; Escape restores the
// original value and blurs; blur restores.
class EditBox extends EditBoxBase {
	constructor(input, options) {
		super(options);
		this._el = input;
		input.maxLength = this._opts.width;
		var self = this;
		this._onKeyDown = function (e) { self._handleKey(e); };
		this._onBlur = function () { self._hasFocus = false; self._updateCursor(); self.restore(); };
		this._onFocus = function () {
			self._hasFocus = true;
			self._layout();
			// Editing starts at the digit that was clicked: leave the
			// browser's caret placement alone.
			self._updateCursor();
		};
		this._onCaretMove = function () { self._updateCursor(); };
		this._onMouseDown = function (e) {
			// Place the caret on the clicked digit immediately (on mouse
			// down) so the block cursor starts blinking on the right digit
			// without waiting for mouse-up, where the browser normally puts
			// the caret.  The browser's own placement then lands on the same
			// digit, so nothing jumps.
			var rect = self._el.getBoundingClientRect();
			var s = getComputedStyle(self._el);
			var x = e.clientX - rect.left - (parseFloat(s.borderLeftWidth) || 0);
			var index = Math.max(0, Math.min(self._opts.width - 1, Math.floor(x / self._charWidth)));
			self._el.setSelectionRange(index, index);
			self._updateCursor();
		};
		input.addEventListener('keydown', this._onKeyDown);
		input.addEventListener('blur', this._onBlur);
		input.addEventListener('focus', this._onFocus);
		input.addEventListener('mousedown', this._onMouseDown);
		// Track caret movement so the block cursor follows it.
		var caretEvents = ['input', 'keyup', 'click', 'select'];
		for (var i = 0; i < caretEvents.length; i++) {
			input.addEventListener(caretEvents[i], this._onCaretMove);
		}
		_viceEditBoxes.push(this);
		_viceEnsureOutsideClickCancel();
		this._layout();
	}
	// End the edit without committing: discard changes, restore the original
	// value, and leave the field.  Equivalent to pressing Escape.
	cancel() {
		this._hasFocus = false;
		this.restore();
		this._updateCursor();
		if (document.activeElement === this._el) { this._el.blur(); }
	}
	_layout() {
		// Size the bounding rectangle to the exact text extent of the font
		// actually used to render the input.  Zero padding anchors the text
		// at the left edge, so digit cell N starts at N * charWidth.
		this._charWidth = measureTextExtent('0', computedFontStyle());
		this._el.style.width = (this._charWidth * this._opts.width) + 'px';
		this._el.style.paddingLeft = '0px';
		this._el.style.paddingRight = '0px';
		this._el.style.textAlign = 'left';
		// The native bar caret is replaced by the block-cursor overlay.
		this._el.style.caretColor = 'transparent';
	}
	_ensureCursorEl() {
		// The cursor overlay lives on document.body and is positioned with
		// getBoundingClientRect().  It must NOT be inserted around the
		// input: re-parenting a focused element makes the browser silently
		// drop focus (no blur event), which left stale blinking cursors and
		// dead inputs after a single click.
		if (!this._cursorEl) {
			this._cursorEl = document.createElement('span');
			this._cursorEl.className = 'vice-block-cursor';
			this._cursorEl.style.animationDuration = (this._opts.blinkRate * 2) + 'ms';
		}
		if (!this._cursorEl.parentNode) { document.body.appendChild(this._cursorEl); }
	}
	_updateCursor() {
		if (!this._hasFocus || this._el.disabled || !document.body.contains(this._el)) {
			if (this._cursorEl) { this._cursorEl.style.display = 'none'; }
			return;
		}
		this._ensureCursorEl();
		var value = this._el.value;
		var caret = this._el.selectionStart === null ? 0 : this._el.selectionStart;
		var index = value.length > 0
			? Math.max(0, Math.min(caret, value.length - 1))
			: 0;
		var rect = this._el.getBoundingClientRect();
		var s = getComputedStyle(this._el);
		var left = rect.left + (parseFloat(s.borderLeftWidth) || 0);
		var top = rect.top + (parseFloat(s.borderTopWidth) || 0);
		this._cursorEl.style.display = '';
		this._cursorEl.style.left = (left + index * this._charWidth) + 'px';
		this._cursorEl.style.top = top + 'px';
		this._cursorEl.style.width = this._charWidth + 'px';
		this._cursorEl.style.height = this._el.clientHeight + 'px';
	}
	_text() { return this._el.value; }
	_setValueText(t) { this._el.value = t; this._updateCursor(); }
	setEnabled(enabled) { this._el.disabled = !enabled; this._updateCursor(); }
	dispose() {
		var index = _viceEditBoxes.indexOf(this);
		if (index >= 0) { _viceEditBoxes.splice(index, 1); }
		this._el.removeEventListener('keydown', this._onKeyDown);
		this._el.removeEventListener('blur', this._onBlur);
		this._el.removeEventListener('focus', this._onFocus);
		this._el.removeEventListener('mousedown', this._onMouseDown);
		var caretEvents = ['input', 'keyup', 'click', 'select'];
		for (var i = 0; i < caretEvents.length; i++) {
			this._el.removeEventListener(caretEvents[i], this._onCaretMove);
		}
	}
	_replaceUnderCaret(e) {
		if (this._opts.replaceWholeOnType) {
			var v0 = this._el.value;
			var s0 = this._el.selectionStart;
			// Append while the value is shorter than the field width (so
			// multi-digit entries like "24" work); replace the whole value
			// once the field is full or the caret sits inside it.
			if (v0.length < this._opts.width && s0 !== null && s0 >= v0.length) {
				this._el.value = v0 + e.key.toUpperCase();
				this._el.setSelectionRange(this._el.value.length, this._el.value.length);
				return;
			}
			this._el.value = e.key.toUpperCase();
			this._el.setSelectionRange(1, 1);
			return;
		}
		var start = this._el.selectionStart;
		var end = this._el.selectionEnd;
		var value = this._el.value;
		if (start === null || end === null) { return; }
		e.preventDefault();
		var key = e.key.toUpperCase();
		if (start !== end) {
			// A selection exists: replace it with the typed character.
			this._el.value = value.substring(0, start) + key + value.substring(end);
			this._el.setSelectionRange(start + 1, start + 1);
			return;
		}
		if (start < value.length) {
			// Overstrike the character under the caret.
			this._el.value = value.substring(0, start) + key + value.substring(start + 1);
			this._el.setSelectionRange(start + 1, start + 1);
		} else if (value.length < this._opts.width) {
			// Short field (Delete/Backspace removed characters): insert.
			this._el.value = value + key;
			this._el.setSelectionRange(this._el.value.length, this._el.value.length);
		} else {
			// Caret at the end of a full field: overwrite the last digit and
			// keep the cursor there (no wrap-around).
			this._el.value = value.substring(0, value.length - 1) + key;
			this._el.setSelectionRange(this._el.value.length, this._el.value.length);
		}
	}
	_insertAtCaret(e) {
		var start = this._el.selectionStart;
		var end = this._el.selectionEnd;
		if (start === null || end === null) { return; }
		this._el.value = this._el.value.substring(0, start) + e.key.toUpperCase() + this._el.value.substring(end);
		this._el.setSelectionRange(start + 1, start + 1);
	}
	_handleChar(e) {
		e.preventDefault();
		if (this._opts.overstrike || this._opts.replaceWholeOnType) { this._replaceUnderCaret(e); }
		else { this._insertAtCaret(e); }
	}
	_handleKey(e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			var v = this._parse(this._text());
			// Enter terminates the edit: end editing and leave the field
			// whether the value is accepted or discarded.
			this._el.blur();
			if (this._isValid(v)) {
				this._value = v;
				if (this._opts.onCommit) { this._opts.onCommit(v); }
			} else {
				this.restore();
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.restore();
			this._el.blur();
		} else if (this._canAcceptKey(e)) {
			this._handleChar(e);
		} else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
		}
	}
}

// Editor that takes over an existing display element (span) and edits it in
// place, so the digits occupy exactly the same pixels before, during, and
// after editing (same element, font, and layout).  The cursor is a blinking
// block: the digit under the cursor is inverted.  Enter commits; Escape or
// blur cancels (restore the display, then invoke onCancel).
class InPlaceEditBox extends EditBoxBase {
	constructor(span, options) {
		super(options);
		this._el = span;
		this._digits = [];
		this._cursor = 0;
		this._blinkOn = true;
		this._blinkTimer = null;
	}
	begin(initialValue) {
		this._value = initialValue;
		this._digits = this._format(initialValue).split('');
		this._cursor = 0;
		var self = this;
		this._onKeyDown = function (e) { self._handleKey(e); };
		this._onBlur = function () { self._cancel(); };
		this._el.addEventListener('keydown', this._onKeyDown);
		this._el.addEventListener('blur', this._onBlur);
		this._el.tabIndex = 0;
		this._el.focus();
		this._renderCursor();
		this._blinkTimer = setInterval(function () {
			self._blinkOn = !self._blinkOn;
			self._renderCursor();
		}, this._opts.blinkRate);
	}
	_text() { return this._digits.join(''); }
	_setValueText(t) { this._digits = t.split(''); this._renderText(); }
	_renderText() { this._el.textContent = this._digits.join(''); }
	_renderCursor() {
		this._el.innerHTML = '';
		for (var i = 0; i < this._digits.length; i++) {
			var c = document.createElement('span');
			c.textContent = this._digits[i];
			if (i === this._cursor && this._blinkOn) {
				c.style.background = 'var(--vscode-editor-foreground)';
				c.style.color = 'var(--vscode-editor-background)';
			}
			this._el.appendChild(c);
		}
	}
	_stopBlink() {
		if (this._blinkTimer !== null) { clearInterval(this._blinkTimer); this._blinkTimer = null; }
	}
	_detach() {
		this._stopBlink();
		this._el.removeEventListener('keydown', this._onKeyDown);
		this._el.removeEventListener('blur', this._onBlur);
	}
	_cancel() {
		this._detach();
		this._renderText();
		if (this._opts.onCancel) { this._opts.onCancel(); }
	}
	_handleKey(e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			var v = this._parse(this._text());
			if (this._isValid(v)) {
				this._detach();
				this._el.textContent = this._format(v);
				this._value = v;
				if (this._opts.onCommit) { this._opts.onCommit(v); }
			} else {
				this._cancel();
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this._cancel();
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			this._blinkOn = true;
			this._cursor = Math.max(0, this._cursor - 1);
			this._renderCursor();
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			this._blinkOn = true;
			this._cursor = Math.min(this._digits.length - 1, this._cursor + 1);
			this._renderCursor();
		} else if (e.key === 'Home') {
			e.preventDefault();
			this._blinkOn = true;
			this._cursor = 0;
			this._renderCursor();
		} else if (e.key === 'End') {
			e.preventDefault();
			this._blinkOn = true;
			this._cursor = this._digits.length - 1;
			this._renderCursor();
		} else if (this._canAcceptKey(e)) {
			e.preventDefault();
			this._digits[this._cursor] = e.key.toUpperCase();
			this._blinkOn = true;
			this._cursor = Math.min(this._digits.length - 1, this._cursor + 1);
			this._renderCursor();
		} else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
		}
	}
}
`;
