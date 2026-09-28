package main

func goroutineCapture(base int) int {
	out := 0
	go func() {
		out = base + 1
	}()
	out = base
	return out
}
