import { describe, expect, it } from "vitest";
import { hasExplicitTimeReference, isReferentialFollowUp, nextQuestionScope, questionWithConversationTopic, topicFromQuestion } from "./conversationContext";

describe("conversation context", () => {
  const activeContext = { propertyId: "p-1", propertyLabel: "Boston Inn", from: "2026-04-25", to: "2026-04-25" };

  it("carries a confirmed day into a short follow-up", () => {
    expect(nextQuestionScope({ question: "why was it low?", activeContext, pageProperty: "all", pageDateRange: {} }))
      .toMatchObject({ propertyId: "p-1", dateFrom: "2026-04-25", dateTo: "2026-04-25", continued: true });
  });

  it("lets a newly named date replace the active date", () => {
    expect(hasExplicitTimeReference("compare with April 26, 2026")).toBe(true);
    expect(nextQuestionScope({ question: "compare with April 26, 2026", activeContext, pageProperty: "all", pageDateRange: { from: "", to: "" } }))
      .toMatchObject({ propertyId: "all", dateFrom: "", dateTo: "", continued: false });
  });

  it("carries the prior topic only for a natural short follow-up", () => {
    expect(topicFromQuestion("Did Expedia bring less money?")).toBe("channels");
    expect(isReferentialFollowUp("why was it low?")).toBe(true);
    expect(questionWithConversationTopic("why was it low?", { ...activeContext, topic: "channels" }, true))
      .toContain("[conversation topic: channels]");
    expect(questionWithConversationTopic("why was Expedia low?", { ...activeContext, topic: "channels" }, true))
      .toBe("why was Expedia low?");
  });
});
