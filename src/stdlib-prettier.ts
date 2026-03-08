/**
 * FreeLang v2 - stdlib-prettier: npm prettier FreeLang 버전 네이티브 함수
 *
 * ✅ 기존 포맷터 재사용:
 *    - src/formatter/pretty-printer.ts → FreeLangPrettyPrinter (AST 역직렬화)
 *    - src/formatter/self-format.ts    → SelfFormatter (파일/소스 포맷 파이프라인)
 *
 * 등록 함수:
 *   prettier_format(code, configJson)           → string
 *   prettier_format_file(filePath, configJson)  → { changed, error, stats }
 *   prettier_format_dir(dirPath, configJson)    → { results[], total, changed, errors }
 *   prettier_check(filePath, configJson)        → bool (needs formatting?)
 *   prettier_read_config(startPath)             → configJson
 *   prettier_read_ignore(startPath)             → string[] (ignored patterns)
 *   prettier_clear_cache()                      → void
 *
 * stdlib/prettier.fl 에서 native_call("prettier_*", [...]) 로 호출.
 */

import { NativeFunctionRegistry } from './vm/native-function-registry';
import { SelfFormatter }          from './formatter/self-format';
import { FormatOptions, DEFAULT_FORMAT_OPTIONS } from './formatter/pretty-printer';
import * as fs   from 'fs';
import * as path from 'path';

// ─── 싱글톤 포맷터 (재사용) ──────────────────────────────────────────────────
const formatter = new SelfFormatter();

// ─── prettier_read_config 결과 캐시 ─────────────────────────────────────────
const configCache = new Map<string, FormatOptions>();

// ─────────────────────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FreeLang PrettierConfig map → FormatOptions 변환
 * null/미지정 필드는 DEFAULT_FORMAT_OPTIONS 값 사용
 */
function toFormatOptions(cfg: Record<string, any> | null): FormatOptions {
  if (!cfg) return { ...DEFAULT_FORMAT_OPTIONS };
  return {
    indent:        cfg.tabWidth        ?? DEFAULT_FORMAT_OPTIONS.indent,
    semi:          cfg.semi            ?? DEFAULT_FORMAT_OPTIONS.semi,
    singleQuote:   cfg.singleQuote     ?? DEFAULT_FORMAT_OPTIONS.singleQuote,
    trailingComma: cfg.trailingComma === 'all', // "none" | "all"
    maxWidth:      cfg.printWidth      ?? DEFAULT_FORMAT_OPTIONS.maxWidth,
  };
}

/**
 * .prettierrc 또는 .prettierrc.fl 파일 탐색 (startPath에서 루트 방향으로)
 */
function findConfigFile(startPath: string): string | null {
  let dir = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  for (let depth = 0; depth < 10; depth++) {
    for (const name of ['.prettierrc.fl', '.prettierrc', '.prettierrc.json']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * .prettierignore 파일 탐색 및 파싱
 */
function readIgnorePatterns(startPath: string): string[] {
  let dir = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, '.prettierignore');
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

/**
 * 파일이 ignore 패턴에 해당하는지 확인
 */
function isIgnored(filePath: string, patterns: string[]): boolean {
  const name = path.basename(filePath);
  return patterns.some(pat => {
    if (pat.startsWith('*')) return name.endsWith(pat.slice(1));
    if (pat.endsWith('/'))   return filePath.includes(pat);
    return name === pat || filePath.endsWith('/' + pat);
  });
}

/**
 * 디렉터리를 재귀 탐색하여 .fl 파일 목록 반환
 */
function collectFlFiles(dir: string, ignorePatterns: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (isIgnored(full, ignorePatterns)) continue;

    if (entry.isDirectory()) {
      // node_modules, .git, dist 스킵
      if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) continue;
      results.push(...collectFlFiles(full, ignorePatterns));
    } else if (entry.isFile() && (entry.name.endsWith('.fl') || entry.name.endsWith('.free'))) {
      results.push(full);
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 네이티브 함수 등록
// ─────────────────────────────────────────────────────────────────────────────

export function registerPrettierFunctions(registry: NativeFunctionRegistry): void {

  // ── prettier_format ────────────────────────────────────────────────────────
  // 소스 문자열을 포맷팅하여 반환
  // Args: [code: string, configJson: object | null]
  // Returns: 포맷팅된 소스 문자열 (오류 시 원본 반환)
  registry.register({
    name: 'prettier_format',
    module: 'prettier',
    executor: (args) => {
      const code = String(args[0] ?? '');
      const cfg  = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, any> : null;
      const opts = toFormatOptions(cfg);

      const { formatted, error } = formatter.formatSource(code, opts);
      if (error) return code; // 파싱 오류 시 원본 반환
      return formatted;
    },
  });

  // ── prettier_format_file ───────────────────────────────────────────────────
  // 파일을 포맷팅 (write=true 시 덮어쓰기)
  // Args: [filePath: string, configJson: object | null, write: bool]
  // Returns: { changed: bool, error: string, stats: { linesOriginal, linesFormatted, charsSaved } }
  registry.register({
    name: 'prettier_format_file',
    module: 'prettier',
    executor: (args) => {
      const filePath = String(args[0] ?? '');
      const cfg      = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, any> : null;
      const write    = Boolean(args[2]);
      const opts     = toFormatOptions(cfg);

      const result = formatter.formatFile(filePath, write, opts);
      return {
        changed: result.changed,
        error:   result.error ?? '',
        stats: {
          linesOriginal:  result.stats.linesOriginal,
          linesFormatted: result.stats.linesFormatted,
          charsSaved:     result.stats.charsSaved,
        },
      };
    },
  });

  // ── prettier_format_dir ────────────────────────────────────────────────────
  // 디렉터리 내 모든 .fl 파일을 포맷팅
  // Args: [dirPath: string, configJson: object | null, write: bool]
  // Returns: { results: [{file, changed, error}], total, changed, errors }
  registry.register({
    name: 'prettier_format_dir',
    module: 'prettier',
    executor: (args) => {
      const dirPath = String(args[0] ?? '.');
      const cfg     = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, any> : null;
      const write   = Boolean(args[2]);
      const opts    = toFormatOptions(cfg);

      const ignorePatterns = readIgnorePatterns(dirPath);
      const files          = collectFlFiles(dirPath, ignorePatterns);

      const results: any[] = [];
      let changedCount = 0;
      let errorCount   = 0;

      for (const f of files) {
        const r = formatter.formatFile(f, write, opts);
        results.push({ file: f, changed: r.changed, error: r.error ?? '' });
        if (r.changed) changedCount++;
        if (r.error)   errorCount++;
      }

      return {
        results,
        total:   files.length,
        changed: changedCount,
        errors:  errorCount,
      };
    },
  });

  // ── prettier_check ─────────────────────────────────────────────────────────
  // 파일이 포맷팅 필요한지 확인 (true = 필요함)
  // Args: [filePath: string, configJson: object | null]
  // Returns: bool
  registry.register({
    name: 'prettier_check',
    module: 'prettier',
    executor: (args) => {
      const filePath = String(args[0] ?? '');
      const cfg      = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, any> : null;
      const opts     = toFormatOptions(cfg);

      const result = formatter.formatFile(filePath, false, opts);
      if (result.error) return false; // 파싱 오류 파일은 무시
      return result.changed;
    },
  });

  // ── prettier_read_config ───────────────────────────────────────────────────
  // .prettierrc / .prettierrc.fl 파일을 탐색·파싱하여 config map 반환
  // Args: [startPath: string]
  // Returns: PrettierConfig map (없으면 default config)
  registry.register({
    name: 'prettier_read_config',
    module: 'prettier',
    executor: (args) => {
      const startPath = String(args[0] ?? '.');

      // 캐시 확인
      if (configCache.has(startPath)) {
        return configCache.get(startPath)!;
      }

      const configFile = findConfigFile(startPath);
      let config: Record<string, any> = {
        printWidth:     DEFAULT_FORMAT_OPTIONS.maxWidth,
        tabWidth:       DEFAULT_FORMAT_OPTIONS.indent,
        useTabs:        false,
        semi:           DEFAULT_FORMAT_OPTIONS.semi,
        singleQuote:    DEFAULT_FORMAT_OPTIONS.singleQuote,
        trailingComma:  'none',
        bracketSpacing: true,
      };

      if (configFile) {
        try {
          const raw = fs.readFileSync(configFile, 'utf-8');

          if (configFile.endsWith('.fl')) {
            // .prettierrc.fl 파싱: key: value 형식
            for (const line of raw.split('\n')) {
              const m = line.match(/^\s*(\w+)\s*[:=]\s*(.+)$/);
              if (!m) continue;
              const [, key, val] = m;
              const trimmed = val.trim().replace(/[",]/g, '');
              if (trimmed === 'true')        config[key] = true;
              else if (trimmed === 'false')  config[key] = false;
              else if (/^\d+$/.test(trimmed)) config[key] = parseInt(trimmed, 10);
              else                           config[key] = trimmed;
            }
          } else {
            // .prettierrc / .prettierrc.json → JSON 파싱
            Object.assign(config, JSON.parse(raw));
          }
        } catch {
          // 파싱 실패 → default 유지
        }
      }

      const opts = toFormatOptions(config);
      configCache.set(startPath, opts as any);
      return config;
    },
  });

  // ── prettier_read_ignore ───────────────────────────────────────────────────
  // .prettierignore 파일 탐색·파싱하여 무시 패턴 배열 반환
  // Args: [startPath: string]
  // Returns: string[]
  registry.register({
    name: 'prettier_read_ignore',
    module: 'prettier',
    executor: (args) => {
      const startPath = String(args[0] ?? '.');
      return readIgnorePatterns(startPath);
    },
  });

  // ── prettier_clear_cache ───────────────────────────────────────────────────
  // 설정 파일 캐시 초기화
  // Args: []
  // Returns: void
  registry.register({
    name: 'prettier_clear_cache',
    module: 'prettier',
    executor: (_args) => {
      configCache.clear();
      return null;
    },
  });

}
