package main

func selectCase(ch chan int, done chan bool) int {
	got := 0
	select {
	case v := <-ch:
		got = v
	case <-done:
		got = -1
	default:
		got = 2
	}
	return got
}
