export interface SqlToken { text: string; kind?: "comment" | "string" | "keyword" | "number" }
const keywords = new Set("select from where join left right inner outer full cross on as and or not null is in exists between like escape group by order having union all intersect minus with over partition distinct case when then else end asc desc fetch first next rows only offset connect start prior level dual insert into values update set delete merge using matched create replace view table alter drop commit rollback begin declare exception loop if return number varchar2 date timestamp nvl nvl2 decode coalesce count sum min max avg row_number trunc to_date to_char sysdate systimestamp listagg regexp_like regexp_substr".split(" "));
export function sqlTokens(sql: string): SqlToken[] {
  return (sql.match(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_][\w$#]*\b|[\s\S]/g) ?? []).map((text) => ({
    text,
    kind: text.startsWith("--") || text.startsWith("/*") ? "comment"
      : text.startsWith("'") || text.startsWith('"') ? "string"
      : keywords.has(text.toLowerCase()) ? "keyword"
      : /^\d/.test(text) ? "number" : undefined,
  }));
}
