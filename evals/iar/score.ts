// Scores an IAR review against a gabarito of verified findings. Deterministic and
// cheap, so every harness change can be measured on the same answers; it reads
// wording, not understanding, so a surprising score is a reason to read the answer.

/** A pattern, or terms that must appear within `within` characters of each other. */
export type Evidence = RegExp | { near: RegExp[]; within?: number };

export interface Finding {
  id: string;
  /** What a correct review says, in one line. */
  descricao: string;
  peso: number;
  /** Any one of these counts as the finding being reported. */
  evidencia: Evidence[];
}

export interface KnownError {
  id: string;
  descricao: string;
  evidencia: Evidence[];
}

export interface IarCase {
  id: string;
  /** Archive file name; the IAR itself is client data and stays out of the repo. */
  arquivo: string;
  pergunta: string;
  achados: Finding[];
  erros: KnownError[];
}

export const ERROR_PENALTY = 0.5;

function matches(text: string, evidence: Evidence): boolean {
  if (evidence instanceof RegExp) return evidence.test(text);
  const within = evidence.within ?? 200;
  const [first, ...rest] = evidence.near;
  for (const hit of text.matchAll(new RegExp(first!.source, `${first!.flags.replace("g", "")}g`))) {
    const window = text.slice(Math.max(0, hit.index - within), hit.index + hit[0].length + within);
    if (rest.every((term) => term.test(window))) return true;
  }
  return false;
}

export function score(text: string, caso: IarCase) {
  const found = (evidencia: Evidence[]) => evidencia.some((e) => matches(text, e));
  const acertos = caso.achados.filter((f) => found(f.evidencia)).map((f) => f.id);
  const faltas = caso.achados.filter((f) => !acertos.includes(f.id)).map((f) => f.id);
  const erros = caso.erros.filter((e) => found(e.evidencia)).map((e) => e.id);
  const total = caso.achados.reduce((sum, f) => sum + f.peso, 0);
  const hit = caso.achados.filter((f) => acertos.includes(f.id)).reduce((sum, f) => sum + f.peso, 0);
  const nota = Math.max(0, Math.round(((10 * hit) / total - ERROR_PENALTY * erros.length) * 10) / 10);
  return { nota, acertos, faltas, erros };
}
