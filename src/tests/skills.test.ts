import { describe, expect, test } from "bun:test";
import { compose } from "../lib/context-composer";
import { buildMessages, contentText } from "../lib/prompt-builder";
import { activeSkills, armSkills, getSkill, SKILLS } from "../lib/skills";
import type { ActiveSkill } from "../lib/types";

const caveman = getSkill("caveman")!;
const clientText = getSkill("client-text")!;

const auto = (id: string): ActiveSkill => ({ skill: getSkill(id)!, mode: "auto" });
const always = (id: string): ActiveSkill => ({
  skill: getSkill(id)!,
  mode: "always",
});

describe("registry", () => {
  test("every skill carries both halves and a source", () => {
    for (const skill of SKILLS) {
      expect(skill.description.length).toBeGreaterThan(40);
      expect(skill.body.length).toBeGreaterThan(200);
      expect(skill.triggers.length).toBeGreaterThan(0);
      if (skill.source) {
        expect(skill.source.repo).toContain("/");
        expect(skill.source.hash).toHaveLength(7);
      }
    }
  });

  test("ids are unique", () => {
    expect(new Set(SKILLS.map((s) => s.id)).size).toBe(SKILLS.length);
  });

  test("the description is the cheap half", () => {
    for (const skill of SKILLS) {
      expect(skill.description.length).toBeLessThan(skill.body.length);
    }
  });
});

describe("activeSkills", () => {
  test("skips ids that are not installed and modes that are off", () => {
    const active = activeSkills({ caveman: "auto", copywriting: "off" });
    expect(active.map((a) => a.skill.id)).toEqual(["caveman"]);
  });

  test("ignores an id the registry no longer carries", () => {
    expect(activeSkills({ "ghost-skill": "always" })).toEqual([]);
  });
});

describe("armSkills", () => {
  test("an auto skill arms on a trigger word", () => {
    const armed = armSkills("keep it brief please", [auto("caveman")]);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.reason).toBe("match");
    expect(armed[0]!.matched).toContain("brief");
  });

  test("an auto skill stays out of a prompt it does not match", () => {
    expect(armSkills("what did we decide about postgres", [auto("caveman")]))
      .toHaveLength(0);
  });

  test("triggers match whole words, not fragments", () => {
    // "emails" contains "email" — a substring match would arm here.
    expect(armSkills("list the emails table columns", [auto("client-text")]))
      .toHaveLength(0);
  });

  test("punctuation in the trigger or the prompt does not block a match", () => {
    const armed = armSkills("manda um e-mail pro cliente", [auto("client-text")]);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.matched).toContain("e mail");
  });

  test("accents do not block a match", () => {
    const armed = armSkills("faz a revisão dessa query", [auto("sql-review")]);
    expect(armed).toHaveLength(1);
    // Both spellings fold to the same word, so the prompt hits each of them.
    expect(armed[0]!.matched).toEqual(expect.arrayContaining(["revisao", "revisão"]));
  });

  test("a plain SQL request does not arm the review checklist", () => {
    expect(armSkills("preciso de um sql para listar invoices", [auto("sql-review")]))
      .toHaveLength(0);
  });

  test("an always skill arms regardless of the prompt", () => {
    const armed = armSkills("anything at all", [always("caveman")]);
    expect(armed[0]!.reason).toBe("always");
    expect(armed[0]!.score).toBe(1);
  });

  test("always-on skills sort ahead of matched ones", () => {
    const armed = armSkills("brief notes on ui design", [
      auto("caveman"),
      always("client-text"),
    ]);
    expect(armed.map((a) => a.skill.id)).toEqual(["client-text", "caveman"]);
  });
});

describe("compose", () => {
  test("an armed skill becomes a chunk the panel can show", () => {
    const context = compose("keep it brief", "p-atimo", "claude-opus-5", [
      auto("caveman"),
    ]);
    const skill = context.chunks.find((c) => c.id === "skill-caveman");
    expect(skill?.label).toBe(caveman.name);
    expect(skill?.included).toBe(true);
    expect(skill?.tokens).toBeGreaterThan(0);
  });

  test("installed skills contribute a required catalogue on every turn", () => {
    const context = compose("hello", "p-atimo", "claude-opus-5", [
      auto("caveman"),
      always("client-text"),
    ]);
    const catalog = context.chunks.find((c) => c.id === "skill-catalog");
    expect(catalog?.required).toBe(true);
    expect(catalog?.included).toBe(true);
    expect(catalog?.excerpt).toContain(caveman.description);
    expect(catalog?.excerpt).toContain(clientText.description);
  });

  test("an armed skill is exempt from the budget", () => {
    const context = compose("keep it brief", "p-atimo", "claude-opus-5", [
      auto("caveman"),
    ]);
    const skill = context.chunks.find((c) => c.id === "skill-caveman");
    expect(skill?.required).toBe(true);
  });

  test("an always-on skill is exempt from the budget", () => {
    const context = compose("hello", "p-atimo", "claude-opus-5", [
      always("client-text"),
    ]);
    const skill = context.chunks.find((c) => c.id === "skill-client-text");
    expect(skill?.required).toBe(true);
  });

  test("every model in a panel receives the same skills", () => {
    const skills = [always("caveman"), auto("client-text")];
    const prompt = "keep it brief and write the email";
    const models = ["claude-opus-5", "gpt-5.6-sol", "gemini-3.1-pro"];

    const systems = models.map((modelId) => {
      const context = compose(prompt, "p-atimo", modelId, skills);
      expect(context.chunks.find((c) => c.id === "skill-catalog")?.included).toBe(
        true,
      );
      expect(context.chunks.find((c) => c.id === "skill-caveman")?.included).toBe(
        true,
      );
      expect(
        context.chunks.find((c) => c.id === "skill-client-text")?.included,
      ).toBe(true);

      return contentText(
        buildMessages({
          context,
          history: [],
          prompt,
          projectName: "Atimo",
        }).map((m) => contentText(m.content)).join("\n\n"),
      );
    });

    for (const content of systems) {
      expect(content).toContain("## Installed skills");
      expect(content).toContain("## Skills active on this turn");
      expect(content).toContain(caveman.body.slice(0, 60));
      expect(content).toContain(clientText.body.slice(0, 60));
      expect(content).toContain("for every model answering this turn");
    }
  });

  test("no installed skills leaves the pipeline untouched", () => {
    const bare = compose("hello there", "p-atimo", "claude-opus-5");
    expect(bare.chunks.some((c) => c.kind === "skill")).toBe(false);
  });
});

describe("buildMessages", () => {
  const system = (prompt: string, skills: ActiveSkill[]) =>
    contentText(
      buildMessages({
        context: compose(prompt, "p-atimo", "claude-opus-5", skills),
        history: [],
        prompt,
        projectName: "Atimo",
      }).map((m) => contentText(m.content)).join("\n\n"),
    );

  test("skill instructions reach the system message", () => {
    const content = system("keep it brief", [auto("caveman")]);
    expect(content).toContain("Skills active on this turn");
    expect(content).toContain(caveman.body.slice(0, 60));
  });

  test("the catalogue is present even when no skill arms", () => {
    const content = system("what did we decide about auth", [auto("caveman")]);
    expect(content).toContain("## Installed skills");
    expect(content).toContain(caveman.description);
    expect(content).not.toContain("## Skills active on this turn");
  });

  test("skills are framed as instructions, not as project facts", () => {
    const content = system("write an email for the client", [auto("client-text")]);
    const catalogAt = content.indexOf("## Installed skills");
    const skillsAt = content.indexOf("## Skills active on this turn");
    const memoryAt = content.indexOf("## Project memory");
    expect(catalogAt).toBeGreaterThan(-1);
    expect(skillsAt).toBeGreaterThan(-1);
    expect(content).toContain("never quote either block as a project decision");
    // Catalogue, then armed bodies, then knowledge.
    expect(catalogAt).toBeLessThan(skillsAt);
    if (memoryAt > -1) expect(skillsAt).toBeLessThan(memoryAt);
    expect(content).toContain(clientText.name);
  });

  test("nothing is added when no skill is installed", () => {
    const content = system("what did we decide about auth", []);
    expect(content).not.toContain("Installed skills");
    expect(content).not.toContain("Skills active on this turn");
  });
});
