package main

func shortCircuitValue(a bool, b bool) bool {
	ok := a && b
	guard := a || b
	return ok && guard
}
