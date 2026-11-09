#!/usr/bin/env python3
"""
run_e2e.py - Master End-to-End Test Runner for Vanilla-Conquer Vulkan & Lean 4

Executes test suites across Tiers 1-4 with milestone filtering and progressive testability:
  Tier 1: Feature Coverage (Category-Partition for Features 1-16)
  Tier 2: Boundary & Corner Cases (Boundary Value Analysis)
  Tier 3: Cross-Feature Interactions (Pairwise combinations)
  Tier 4: Real-World Scenarios (Launch, VQA cutscenes, menus, 100+ tick differential match)
"""

import os
import sys
import json
import time
import argparse
from typing import List, Dict, Any

# Ensure current directory is in python module search path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common_harness import TestCaseResult, TestStatus, find_repo_root
from test_tier1_feature_coverage import run_tier1_tests
from test_tier2_boundary_corner import run_tier2_tests
from test_tier3_cross_feature import run_tier3_tests
from test_tier4_scenarios import run_tier4_tests


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="End-to-End Test Suite Runner for Vanilla-Conquer Vulkan & Lean 4",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--tier",
        type=str,
        default="all",
        choices=["1", "2", "3", "4", "all"],
        help="Test tier to execute",
    )
    parser.add_argument(
        "--milestone",
        type=str,
        default="all",
        choices=["m1", "m2", "m3", "m4", "m5", "all"],
        help="Target milestone scope (m1..m5, all)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Strict mode: treat pending milestone features as failures",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Print verbose diagnostic details for every test",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Print machine-readable JSON results to stdout",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="",
        help="Save test results JSON report to specified file path",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Display test execution plan without running heavy tests",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    repo_root = find_repo_root()

    selected_tiers = [1, 2, 3, 4] if args.tier == "all" else [int(args.tier)]
    target_ms = args.milestone.upper()

    if not args.json_output:
        print("=" * 80)
        print(" Vanilla-Conquer End-to-End Test Suite Runner")
        print(f" Repository: {repo_root}")
        print(f" Target Milestone: {target_ms} | Tiers: {selected_tiers} | Strict: {args.strict}")
        print("=" * 80)

    if args.dry_run:
        print("Dry run requested. Planned execution:")
        for tier in selected_tiers:
            print(f" - Tier {tier} suite scheduled.")
        return 0

    all_results: List[TestCaseResult] = []
    start_time = time.time()

    # Tier 1
    if 1 in selected_tiers:
        if not args.json_output:
            print("\n--- Running Tier 1: Feature Coverage (Category-Partition) ---")
        t1_results = run_tier1_tests(target_milestone=args.milestone, strict=args.strict)
        all_results.extend(t1_results)
        if not args.json_output:
            for t in t1_results:
                icon = "✔ PASS" if t.status == TestStatus.PASS else ("⏳ PENDING" if t.status == TestStatus.PENDING_MILESTONE else "✖ FAIL")
                print(f"  [{icon:9}] {t.name:<45} [{t.milestone}] {t.duration_ms:6.1f}ms: {t.message}")

    # Tier 2
    if 2 in selected_tiers:
        if not args.json_output:
            print("\n--- Running Tier 2: Boundary & Corner Cases (BVA) ---")
        t2_results = run_tier2_tests(target_milestone=args.milestone, strict=args.strict)
        all_results.extend(t2_results)
        if not args.json_output:
            for t in t2_results:
                icon = "✔ PASS" if t.status == TestStatus.PASS else ("⏳ PENDING" if t.status == TestStatus.PENDING_MILESTONE else "✖ FAIL")
                print(f"  [{icon:9}] {t.name:<45} [{t.milestone}] {t.duration_ms:6.1f}ms: {t.message}")

    # Tier 3
    if 3 in selected_tiers:
        if not args.json_output:
            print("\n--- Running Tier 3: Cross-Feature Interactions (Pairwise) ---")
        t3_results = run_tier3_tests(target_milestone=args.milestone, strict=args.strict)
        all_results.extend(t3_results)
        if not args.json_output:
            for t in t3_results:
                icon = "✔ PASS" if t.status == TestStatus.PASS else ("⏳ PENDING" if t.status == TestStatus.PENDING_MILESTONE else "✖ FAIL")
                print(f"  [{icon:9}] {t.name:<45} [{t.milestone}] {t.duration_ms:6.1f}ms: {t.message}")

    # Tier 4
    if 4 in selected_tiers:
        if not args.json_output:
            print("\n--- Running Tier 4: Real-World Scenarios (Workloads) ---")
        t4_results = run_tier4_tests(target_milestone=args.milestone, strict=args.strict)
        all_results.extend(t4_results)
        if not args.json_output:
            for t in t4_results:
                icon = "✔ PASS" if t.status == TestStatus.PASS else ("⏳ PENDING" if t.status == TestStatus.PENDING_MILESTONE else "✖ FAIL")
                print(f"  [{icon:9}] {t.name:<45} [{t.milestone}] {t.duration_ms:6.1f}ms: {t.message}")

    total_duration_ms = (time.time() - start_time) * 1000.0

    # Aggregate counts
    pass_count = sum(1 for r in all_results if r.status == TestStatus.PASS)
    fail_count = sum(1 for r in all_results if r.status == TestStatus.FAIL)
    skip_count = sum(1 for r in all_results if r.status == TestStatus.SKIPPED)
    pending_count = sum(1 for r in all_results if r.status == TestStatus.PENDING_MILESTONE)
    total_count = len(all_results)

    # Milestone filtering for pass/fail determination
    active_results = all_results
    if target_ms != "ALL":
        active_results = [r for r in all_results if r.milestone == target_ms]

    active_fails = sum(1 for r in active_results if r.status == TestStatus.FAIL)
    if args.strict:
        active_fails += sum(1 for r in active_results if r.status == TestStatus.PENDING_MILESTONE)

    report_dict = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repo_root": repo_root,
        "target_milestone": target_ms,
        "tiers_executed": selected_tiers,
        "strict_mode": args.strict,
        "summary": {
            "total": total_count,
            "passed": pass_count,
            "failed": fail_count,
            "pending_milestone": pending_count,
            "skipped": skip_count,
            "duration_ms": round(total_duration_ms, 2),
            "pass_rate_pct": round((pass_count / total_count * 100.0) if total_count > 0 else 0.0, 1),
        },
        "tests": [r.to_dict() for r in all_results],
    }

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(report_dict, f, indent=2)
        if not args.json_output:
            print(f"\nJSON report written to: {args.output}")

    if args.json_output:
        print(json.dumps(report_dict, indent=2))
    else:
        print("\n" + "=" * 80)
        print(" TEST EXECUTION SUMMARY")
        print("=" * 80)
        print(f" Total Tests : {total_count}")
        print(f" Passed      : {pass_count}")
        print(f" Failed      : {fail_count}")
        print(f" Pending     : {pending_count} (awaiting future milestone implementation)")
        print(f" Skipped     : {skip_count}")
        print(f" Duration    : {total_duration_ms:.1f}ms")
        print(f" Target Scope: {target_ms} Failures: {active_fails}")
        print("=" * 80)

    return 1 if active_fails > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
