// test_callhierarchy.cpp
// A minimal C++ file with a clear call hierarchy for testing
// the intelgraph incoming/outgoing call queries.

#include <cstdio>

// ── leaf functions ──────────────────────────────────────────────────────────

int add(int a, int b) {
    return a + b;
}

int multiply(int a, int b) {
    return a * b;
}

void log_result(int result) {
    printf("result: %d\n", result);
}

// ── mid-level functions ─────────────────────────────────────────────────────

int compute(int x, int y) {
    int sum = add(x, y);
    int product = multiply(x, y);
    log_result(sum);
    log_result(product);
    return sum + product;
}

int process(int value) {
    int doubled = multiply(value, 2);
    log_result(doubled);
    return compute(value, doubled);
}

// ── top-level entry ─────────────────────────────────────────────────────────

int main() {
    int result = process(5);
    log_result(result);
    return 0;
}
