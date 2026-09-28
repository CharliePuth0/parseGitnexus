package main

func rangeContinue(xs []int) int {
	sum := 0
	for _, v := range xs {
		if v < 0 {
			continue
		}
		sum += v
	}
	return sum
}
