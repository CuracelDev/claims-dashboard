import unittest
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from scripts.piles_auto_assignment.planning import (
    InvalidAssignmentConfiguration,
    batch_plans,
    eligible_bots,
    plan_assignments,
    validate_rule,
)


LAGOS = ZoneInfo("Africa/Lagos")


def bot(name, *, role="primary", start="09:00", end="", active=True):
    return SimpleNamespace(
        id=name.lower(), owner_name=name, bot_name=name, assignment_role=role,
        support_capacity_ratio=1, availability_status="available",
        is_active=active, is_available=True, active_from_time=start,
        active_to_time=end, priority_order=1, current_claim_load=0,
    )


def pile(index, *, total=20, remaining=None):
    return SimpleNamespace(
        key=f"volatile-{index}", tracking_key=f"pile-{index}", provider=f"Provider {index}",
        claims=total, remaining_claims=total if remaining is None else remaining,
        assignment_type="Vetting", status_bucket="Vetting Pending",
        filter_month="All", filter_year="2026",
    )


def rule(mode="balanced_finish", minimum=25):
    return SimpleNamespace(distribution_mode=mode, minimum_claim_chunk=minimum)


class PlanningTests(unittest.TestCase):
    def test_planning_uses_remaining_claims_and_excludes_completed_piles(self):
        result = plan_assignments(
            "balanced_finish",
            [pile(1, total=20, remaining=4), pile(2, total=8, remaining=0)],
            [bot("Daniel", start="")],
            {},
            rule(),
        )
        self.assertEqual(sum(plan.work_claims for plan in result.plans), 4)
        self.assertEqual(result.exclusions[0].reason_code, "no_remaining_claims")

    def test_bot_outside_active_window_is_excluded_with_reason(self):
        result = eligible_bots(
            [bot("Daniel", start="09:00", end="17:00")],
            effective_at=datetime(2026, 9, 8, 20, 0, tzinfo=LAGOS),
        )
        self.assertEqual(result.exclusions[0].reason_code, "outside_active_window")

    def test_overnight_active_window_is_supported(self):
        result = eligible_bots(
            [bot("Night", start="20:00", end="04:00")],
            effective_at=datetime(2026, 9, 8, 23, 0, tzinfo=LAGOS),
        )
        self.assertEqual([item.id for item in result.eligible], ["night"])

    def test_single_owner_rejects_multiple_available_primaries(self):
        with self.assertRaises(InvalidAssignmentConfiguration):
            plan_assignments(
                "single_owner", [pile(1)], [bot("A"), bot("B")], {}, rule("single_owner")
            )

    def test_manual_override_creates_manual_dispositions_without_assignments(self):
        piles = [pile(1), pile(2)]
        result = plan_assignments(
            "manual_override", piles, [bot("Daniel")], {}, rule("manual_override")
        )
        self.assertEqual(result.plans, ())
        self.assertEqual(len(result.manual_action_required), len(piles))

    def test_minimum_chunk_never_drops_final_remainder(self):
        result = plan_assignments(
            "single_owner",
            [pile(1, total=12), pile(2, total=11), pile(3, total=7)],
            [bot("Daniel", start="")],
            {},
            rule("single_owner", 25),
        )
        batches = batch_plans(result.plans, target_claims=25)
        self.assertEqual(sum(len(batch.items) for batch in batches), 3)
        self.assertEqual([batch.work_claims for batch in batches], [30])

    def test_invalid_rule_values_fail_closed(self):
        with self.assertRaises(InvalidAssignmentConfiguration):
            validate_rule(rule("unsupported", 25))
        with self.assertRaises(InvalidAssignmentConfiguration):
            validate_rule(rule("balanced_finish", 0))


if __name__ == "__main__":
    unittest.main()
